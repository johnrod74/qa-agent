/**
 * Codebase Analyzer — reads a target application's source code and produces
 * a structured understanding of its routes, forms, APIs, data models, etc.
 *
 * Spec reference: Section 5 (App Analyzer)
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, basename, extname, dirname } from 'node:path';
import type { QAAgentConfig } from './config.js';
import { safeReadFile } from './fs-utils.js';

// ---------------------------------------------------------------------------
// Exported interfaces (spec §5.1)
// ---------------------------------------------------------------------------

export interface Route {
  path: string;
  method: 'page' | 'api';
  params?: string[];
  auth?: { required: boolean; roles?: string[] };
  description?: string;
}

export interface ApiEndpoint {
  path: string;
  methods: Array<'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'>;
  filePath: string;
  description?: string;
}

export interface Component {
  name: string;
  filePath: string;
  type: 'page' | 'layout' | 'component' | 'form' | 'modal' | 'unknown';
  props?: string[];
}

export interface FormField {
  name: string;
  type: 'text' | 'email' | 'number' | 'select' | 'checkbox' | 'radio' | 'textarea' | 'date' | 'time';
  required: boolean;
  constraints?: {
    min?: number;
    max?: number;
    minLength?: number;
    maxLength?: number;
    pattern?: string;
    enum?: string[];
  };
}

export interface Form {
  location: string;
  fields: FormField[];
  submitAction: string;
  validationSchema?: string;
}

export interface StateStore {
  name: string;
  filePath: string;
  type: 'zustand' | 'redux' | 'context' | 'other';
  keys: string[];
}

export interface Rule {
  description: string;
  location: string;
  type: 'validation' | 'business' | 'authorization' | 'computation';
}

export interface AuthFlow {
  provider: string;
  type: 'credentials' | 'oauth' | 'magic-link' | 'unknown';
  loginPath?: string;
  callbackPath?: string;
}

export interface DataModel {
  name: string;
  fields: Array<{ name: string; type: string; required: boolean; relation?: string }>;
  filePath: string;
}

export interface AppAnalysis {
  routes: Route[];
  apiEndpoints: ApiEndpoint[];
  components: Component[];
  forms: Form[];
  stateStores: StateStore[];
  businessRules: Rule[];
  authFlows: AuthFlow[];
  dataModels: DataModel[];
}

// ---------------------------------------------------------------------------
// Limits for codebase analysis (B4 — prevent context-window blow-up)
// ---------------------------------------------------------------------------

/** Maximum number of source files to include in analysis. */
const MAX_FILES = 500;

/** Maximum individual file size (in bytes) to read. Files larger are skipped. */
const MAX_FILE_SIZE_BYTES = 100_000; // 100 KB

// ---------------------------------------------------------------------------
// Pre-compiled regex patterns (avoid re-creation on every call)
// ---------------------------------------------------------------------------

/** Patterns for detecting HTTP method exports in route files. */
const HTTP_METHOD_PATTERNS: Record<string, RegExp> = {
  GET: /export\s+(?:async\s+)?(?:function|const)\s+GET\b/,
  POST: /export\s+(?:async\s+)?(?:function|const)\s+POST\b/,
  PUT: /export\s+(?:async\s+)?(?:function|const)\s+PUT\b/,
  DELETE: /export\s+(?:async\s+)?(?:function|const)\s+DELETE\b/,
  PATCH: /export\s+(?:async\s+)?(?:function|const)\s+PATCH\b/,
};

/** Pattern for matching Zod schema definitions. */
const ZOD_SCHEMA_PATTERN = /(?:const|let|export\s+(?:const|let))\s+(\w+)\s*=\s*z\.object\(\{([^}]*(?:\{[^}]*\}[^}]*)*)\}\)/gs;

/** Pattern for matching individual Zod field definitions inside a schema. */
const ZOD_FIELD_PATTERN = /(\w+)\s*:\s*z\.(\w+)\(([^)]*)\)((?:\.\w+\([^)]*\))*)/g;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Recursively walk a directory, yielding file paths that match a filter. */
function walkDir(dir: string, filter?: (file: string) => boolean): string[] {
  const results: string[] = [];
  if (!existsSync(dir)) return results;

  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      // Skip common non-source directories
      if (['node_modules', '.next', '.git', 'dist', 'build'].includes(entry.name)) continue;
      results.push(...walkDir(fullPath, filter));
    } else if (!filter || filter(fullPath)) {
      results.push(fullPath);
    }
  }
  return results;
}

/** Convert a Next.js App Router file path to a URL route path. */
function filePathToRoute(filePath: string, appDir: string): string {
  let routePath = relative(appDir, dirname(filePath));
  // Strip route group markers like (storefront)
  routePath = routePath.replace(/\([^)]+\)\/?/g, '');
  // Convert dynamic segments [slug] -> :slug
  routePath = routePath.replace(/\[\.\.\.(\w+)\]/g, ':$1*');
  routePath = routePath.replace(/\[(\w+)\]/g, ':$1');
  // Normalise slashes
  routePath = '/' + routePath.replace(/\\/g, '/');
  if (routePath !== '/') {
    routePath = routePath.replace(/\/$/, '');
  }
  return routePath;
}

/** Extract dynamic params from a route path string. */
function extractParams(routePath: string): string[] | undefined {
  const params: string[] = [];
  const re = /:(\w+)\*?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(routePath)) !== null) {
    params.push(m[1]);
  }
  return params.length > 0 ? params : undefined;
}

/** Detect HTTP methods exported from a route.ts file. */
function detectHttpMethods(content: string): Array<'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'> {
  const methods: Array<'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'> = [];
  const httpMethods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'] as const;
  for (const method of httpMethods) {
    if (HTTP_METHOD_PATTERNS[method].test(content)) {
      methods.push(method);
    }
  }
  return methods;
}

/** Map a Zod type string to a FormField type. */
function zodTypeToFieldType(zodType: string): FormField['type'] {
  if (zodType.includes('email')) return 'email';
  if (zodType.includes('number') || zodType.includes('int') || zodType.includes('float')) return 'number';
  if (zodType.includes('boolean')) return 'checkbox';
  if (zodType.includes('date')) return 'date';
  if (zodType.includes('enum')) return 'select';
  return 'text';
}

/** Parse Zod schema fields from file content. Returns forms found. */
function extractZodForms(content: string, filePath: string): Form[] {
  const forms: Form[] = [];

  // Reset lastIndex for the global regex before each use
  ZOD_SCHEMA_PATTERN.lastIndex = 0;
  let schemaMatch: RegExpExecArray | null;

  while ((schemaMatch = ZOD_SCHEMA_PATTERN.exec(content)) !== null) {
    const schemaName = schemaMatch[1];
    const schemaBody = schemaMatch[2];
    const fields: FormField[] = [];

    // Reset lastIndex for the global field regex before each schema body
    ZOD_FIELD_PATTERN.lastIndex = 0;
    let fieldMatch: RegExpExecArray | null;

    while ((fieldMatch = ZOD_FIELD_PATTERN.exec(schemaBody)) !== null) {
      const fieldName = fieldMatch[1];
      const zodBaseType = fieldMatch[2];
      const chainedMethods = fieldMatch[4] || '';

      const fieldType = zodTypeToFieldType(zodBaseType);
      const required = !chainedMethods.includes('.optional()') && !chainedMethods.includes('.nullable()');
      const constraints: FormField['constraints'] = {};

      // Extract constraints from chained methods
      const minMatch = chainedMethods.match(/\.min\((\d+)\)/);
      const maxMatch = chainedMethods.match(/\.max\((\d+)\)/);
      const minLenMatch = chainedMethods.match(/\.minLength\((\d+)\)/);
      const maxLenMatch = chainedMethods.match(/\.maxLength\((\d+)\)/);
      const regexMatch = chainedMethods.match(/\.regex\(\/([^/]+)\/\)/);

      if (fieldType === 'number') {
        if (minMatch) constraints.min = Number(minMatch[1]);
        if (maxMatch) constraints.max = Number(maxMatch[1]);
      } else {
        if (minMatch) constraints.minLength = Number(minMatch[1]);
        if (maxMatch) constraints.maxLength = Number(maxMatch[1]);
      }
      if (minLenMatch) constraints.minLength = Number(minLenMatch[1]);
      if (maxLenMatch) constraints.maxLength = Number(maxLenMatch[1]);
      if (regexMatch) constraints.pattern = regexMatch[1];

      // Extract enum values from z.enum([...])
      if (zodBaseType === 'enum') {
        const enumArg = fieldMatch[3];
        const enumValues = enumArg.match(/['"]([^'"]+)['"]/g);
        if (enumValues) {
          constraints.enum = enumValues.map((v) => v.replace(/['"]/g, ''));
        }
      }

      const hasConstraints = Object.keys(constraints).length > 0;

      fields.push({
        name: fieldName,
        type: fieldType,
        required,
        ...(hasConstraints ? { constraints } : {}),
      });
    }

    if (fields.length > 0) {
      forms.push({
        location: filePath,
        fields,
        submitAction: schemaName,
        validationSchema: schemaName,
      });
    }
  }

  return forms;
}

/** Parse Prisma schema file and extract data models. */
function parsePrismaSchema(content: string, filePath: string): DataModel[] {
  const models: DataModel[] = [];
  const modelPattern = /model\s+(\w+)\s*\{([^}]+)\}/g;
  let modelMatch: RegExpExecArray | null;

  while ((modelMatch = modelPattern.exec(content)) !== null) {
    const modelName = modelMatch[1];
    const modelBody = modelMatch[2];
    const fields: DataModel['fields'] = [];

    const lines = modelBody.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      // Skip comments and empty lines and directives
      if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('@@')) continue;

      // Match: fieldName Type? @relation(...) or fieldName Type[]
      const fieldPattern = /^(\w+)\s+(\w+)(\[\])?(\?)?/;
      const fieldMatch = trimmed.match(fieldPattern);
      if (!fieldMatch) continue;

      const [, name, type, isArray, isOptional] = fieldMatch;
      // Skip Prisma directives that look like fields (e.g. @@index)
      if (name.startsWith('@@')) continue;

      const required = !isOptional;
      const relationMatch = trimmed.match(/@relation\(([^)]*)\)/);
      const relation = relationMatch
        ? type + (isArray ? '[]' : '')
        : undefined;

      fields.push({ name, type: type + (isArray ? '[]' : ''), required, ...(relation ? { relation } : {}) });
    }

    if (fields.length > 0) {
      models.push({ name: modelName, fields, filePath });
    }
  }

  return models;
}

/** Detect state management stores in a file. */
function detectStateStores(content: string, filePath: string): StateStore[] {
  const stores: StateStore[] = [];

  // Zustand: create<...>((set) => ({ ... }))
  const zustandMatch = content.match(/(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*create[<(]/);
  if (zustandMatch) {
    const keys = extractStoreKeys(content);
    stores.push({ name: zustandMatch[1], filePath, type: 'zustand', keys });
  }

  // React Context: createContext
  const contextPattern = /(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*(?:React\.)?createContext/g;
  let ctxMatch: RegExpExecArray | null;
  while ((ctxMatch = contextPattern.exec(content)) !== null) {
    stores.push({ name: ctxMatch[1], filePath, type: 'context', keys: [] });
  }

  // Redux: createSlice
  const reduxMatch = content.match(/createSlice\(\s*\{[^}]*name:\s*['"](\w+)['"]/);
  if (reduxMatch) {
    stores.push({ name: reduxMatch[1], filePath, type: 'redux', keys: [] });
  }

  return stores;
}

/** Try to extract state keys from a Zustand store definition. */
function extractStoreKeys(content: string): string[] {
  const keys: string[] = [];
  // Look for property assignments after set => pattern
  const statePattern = /(\w+)\s*:/g;
  // Simple heuristic — find the store body
  const bodyStart = content.indexOf('({');
  const bodyEnd = content.indexOf('})', bodyStart);
  if (bodyStart < 0 || bodyEnd < 0) return keys;

  const body = content.slice(bodyStart + 2, bodyEnd);
  let m: RegExpExecArray | null;
  while ((m = statePattern.exec(body)) !== null) {
    const key = m[1];
    // Skip common non-state keys
    if (!['set', 'get', 'async', 'await', 'return', 'const', 'let', 'if', 'else'].includes(key)) {
      keys.push(key);
    }
  }
  return [...new Set(keys)];
}

/** Detect authentication patterns in a codebase. */
function detectAuth(files: string[], codebasePath: string): AuthFlow[] {
  const flows: AuthFlow[] = [];

  for (const file of files) {
    const content = safeReadFile(file);
    const relPath = relative(codebasePath, file);

    // NextAuth / Auth.js
    if (content.includes('NextAuth') || content.includes('authOptions') || content.includes('Auth(')) {
      const isCredentials = content.includes('CredentialsProvider') || content.includes('credentials');
      const isOAuth = content.includes('GoogleProvider') || content.includes('GitHubProvider') || content.includes('OAuthProvider');

      if (isCredentials) {
        flows.push({
          provider: 'next-auth',
          type: 'credentials',
          loginPath: '/api/auth/signin',
          callbackPath: '/api/auth/callback',
        });
      }
      if (isOAuth) {
        flows.push({
          provider: 'next-auth',
          type: 'oauth',
          loginPath: '/api/auth/signin',
          callbackPath: '/api/auth/callback',
        });
      }
    }

    // Custom login pages
    if (relPath.includes('login') && (content.includes('<form') || content.includes('onSubmit'))) {
      const routePath = filePathToRoute(file, join(codebasePath, 'src', 'app'));
      flows.push({
        provider: 'custom',
        type: 'credentials',
        loginPath: routePath,
      });
    }
  }

  // Deduplicate by provider+type
  const seen = new Set<string>();
  return flows.filter((f) => {
    const key = `${f.provider}:${f.type}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Detect auth requirements in a page/component by looking for session/auth checks. */
function detectRouteAuth(content: string): Route['auth'] | undefined {
  const hasAuthCheck =
    content.includes('useSession') ||
    content.includes('getServerSession') ||
    content.includes('auth()') ||
    content.includes('requireAuth') ||
    content.includes('middleware') ||
    content.includes('redirect') && content.includes('login');

  if (!hasAuthCheck) return undefined;

  const roles: string[] = [];
  // Try to detect role checks like role === 'admin' or roles.includes('owner')
  const rolePattern = /(?:role|roles?).*?['"](\w+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = rolePattern.exec(content)) !== null) {
    if (!['string', 'number', 'boolean', 'undefined', 'null', 'object'].includes(m[1])) {
      roles.push(m[1]);
    }
  }

  return { required: true, ...(roles.length > 0 ? { roles } : {}) };
}

/** Extract business rules from service/lib files. */
function extractBusinessRules(content: string, filePath: string): Rule[] {
  const rules: Rule[] = [];

  // Look for validation/business logic comments
  const commentPattern = /\/\/\s*(RULE|BUSINESS|VALIDATE|CONSTRAINT|INVARIANT)[:\s]+(.+)/gi;
  let m: RegExpExecArray | null;
  while ((m = commentPattern.exec(content)) !== null) {
    rules.push({
      description: m[2].trim(),
      location: filePath,
      type: 'business',
    });
  }

  // Look for throw new Error patterns that indicate business rules
  const throwPattern = /throw\s+new\s+(?:Error|AppError|ValidationError)\(['"`]([^'"`]+)['"`]\)/g;
  while ((m = throwPattern.exec(content)) !== null) {
    rules.push({
      description: m[1],
      location: filePath,
      type: 'validation',
    });
  }

  return rules;
}

// ---------------------------------------------------------------------------
// Framework detection
// ---------------------------------------------------------------------------

interface FrameworkInfo {
  name: string;
  version?: string;
  router?: 'app' | 'pages';
}

function detectFramework(codebasePath: string): FrameworkInfo {
  const pkgPath = join(codebasePath, 'package.json');
  if (!existsSync(pkgPath)) {
    return { name: 'unknown' };
  }

  const pkg = JSON.parse(safeReadFile(pkgPath));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };

  if (deps['next']) {
    const version = deps['next']?.replace(/[\^~>=<]/g, '');
    // Detect App Router vs Pages Router
    const hasAppDir = existsSync(join(codebasePath, 'src', 'app')) || existsSync(join(codebasePath, 'app'));
    const hasPagesDir = existsSync(join(codebasePath, 'src', 'pages')) || existsSync(join(codebasePath, 'pages'));
    return {
      name: 'nextjs',
      version,
      router: hasAppDir ? 'app' : hasPagesDir ? 'pages' : 'app',
    };
  }

  if (deps['nuxt'] || deps['nuxt3']) return { name: 'nuxt' };
  if (deps['vue']) return { name: 'vue' };
  if (deps['svelte'] || deps['@sveltejs/kit']) return { name: 'svelte' };
  if (deps['react']) return { name: 'react' };

  return { name: 'unknown' };
}

// ---------------------------------------------------------------------------
// Main analysis function
// ---------------------------------------------------------------------------

/**
 * Analyze a target application's codebase and produce a structured understanding.
 *
 * Currently has deep support for Next.js App Router projects; other frameworks
 * receive basic analysis.
 */
export async function analyzeApp(config: QAAgentConfig): Promise<AppAnalysis> {
  const codebasePath = config.app.codebasePath;

  const framework = detectFramework(codebasePath);

  const routes: Route[] = [];
  const apiEndpoints: ApiEndpoint[] = [];
  const components: Component[] = [];
  const forms: Form[] = [];
  const stateStores: StateStore[] = [];
  const businessRules: Rule[] = [];
  const dataModels: DataModel[] = [];

  // -------------------------------------------------------------------------
  // Discover App Router structure
  // -------------------------------------------------------------------------

  const appDir =
    existsSync(join(codebasePath, 'src', 'app'))
      ? join(codebasePath, 'src', 'app')
      : existsSync(join(codebasePath, 'app'))
        ? join(codebasePath, 'app')
        : null;

  if (appDir && framework.name === 'nextjs') {
    const allAppFiles = walkDir(appDir, (f) => /\.(ts|tsx|js|jsx)$/.test(f));

    for (const file of allAppFiles) {
      const fileName = basename(file);
      const content = safeReadFile(file);
      const routePath = filePathToRoute(file, appDir);

      // Page routes
      if (fileName === 'page.tsx' || fileName === 'page.ts' || fileName === 'page.jsx' || fileName === 'page.js') {
        const auth = detectRouteAuth(content);
        const params = extractParams(routePath);
        routes.push({
          path: routePath,
          method: 'page',
          ...(params ? { params } : {}),
          ...(auth ? { auth } : {}),
        });
      }

      // API routes
      if (fileName === 'route.ts' || fileName === 'route.js') {
        const methods = detectHttpMethods(content);
        if (methods.length > 0) {
          apiEndpoints.push({
            path: routePath,
            methods,
            filePath: file,
          });
        }
        const apiParams = extractParams(routePath);
        routes.push({
          path: routePath,
          method: 'api',
          ...(apiParams ? { params: apiParams } : {}),
        });
      }

      // Layout components
      if (fileName.startsWith('layout.')) {
        components.push({
          name: `Layout:${routePath}`,
          filePath: file,
          type: 'layout',
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Scan all source files for forms, stores, rules, and components
  // -------------------------------------------------------------------------

  let sourceFiles = walkDir(codebasePath, (f) => {
    const ext = extname(f);
    if (!['.ts', '.tsx', '.js', '.jsx'].includes(ext)) return false;
    if (f.includes('node_modules') || f.includes('.next') || f.includes('dist')) return false;
    // Respect exclude globs (simple substring matching for performance)
    if (config.context.excludeGlobs) {
      for (const glob of config.context.excludeGlobs) {
        const pattern = glob.replace(/\*\*/g, '').replace(/\*/g, '');
        if (pattern && f.includes(pattern)) return false;
      }
    }
    return true;
  });

  // Enforce file count limit (B4)
  if (sourceFiles.length > MAX_FILES) {
    console.warn(
      `[qa-agent] WARNING: Found ${sourceFiles.length} source files, exceeding limit of ${MAX_FILES}. Truncating to first ${MAX_FILES} files.`,
    );
    sourceFiles = sourceFiles.slice(0, MAX_FILES);
  }

  let skippedDueToSize = 0;

  for (const file of sourceFiles) {
    // Skip files that exceed size limit (B4)
    try {
      const fileStat = statSync(file);
      if (fileStat.size > MAX_FILE_SIZE_BYTES) {
        skippedDueToSize++;
        console.warn(
          `[qa-agent] WARNING: Skipping ${relative(codebasePath, file)} (${fileStat.size} bytes exceeds ${MAX_FILE_SIZE_BYTES} byte limit)`,
        );
        continue;
      }
    } catch {
      // If stat fails, skip the file
      skippedDueToSize++;
      continue;
    }

    const content = safeReadFile(file);
    const relPath = relative(codebasePath, file);
    const fileName = basename(file, extname(file));

    // Zod forms
    if (content.includes('z.object')) {
      const fileForms = extractZodForms(content, file);
      forms.push(...fileForms);
    }

    // State stores
    const fileStores = detectStateStores(content, file);
    stateStores.push(...fileStores);

    // Business rules from service/lib files
    if (
      relPath.includes('service') ||
      relPath.includes('lib') ||
      relPath.includes('util') ||
      relPath.includes('helper') ||
      relPath.includes('action')
    ) {
      const fileRules = extractBusinessRules(content, file);
      businessRules.push(...fileRules);
    }

    // Component detection (files in components/ directories)
    if (relPath.includes('component') && (extname(file) === '.tsx' || extname(file) === '.jsx')) {
      const isForm = content.includes('<form') || content.includes('onSubmit') || content.includes('useForm');
      const isModal = content.includes('modal') || content.includes('dialog') || content.includes('Dialog');

      // Extract props from the component
      const propsMatch = content.match(/(?:interface|type)\s+\w*Props\s*(?:=\s*)?\{([^}]+)\}/);
      const props: string[] = [];
      if (propsMatch) {
        const propsBody = propsMatch[1];
        const propPattern = /(\w+)\s*[?:]?\s*:/g;
        let pm: RegExpExecArray | null;
        while ((pm = propPattern.exec(propsBody)) !== null) {
          props.push(pm[1]);
        }
      }

      components.push({
        name: fileName,
        filePath: file,
        type: isForm ? 'form' : isModal ? 'modal' : 'component',
        ...(props.length > 0 ? { props } : {}),
      });
    }
  }

  // -------------------------------------------------------------------------
  // Prisma models
  // -------------------------------------------------------------------------

  const prismaSchemaPath = join(codebasePath, 'prisma', 'schema.prisma');
  if (existsSync(prismaSchemaPath)) {
    const prismaContent = safeReadFile(prismaSchemaPath);
    const models = parsePrismaSchema(prismaContent, prismaSchemaPath);
    dataModels.push(...models);
  }

  // Also check for schema.prisma at root
  const rootPrismaPath = join(codebasePath, 'schema.prisma');
  if (existsSync(rootPrismaPath)) {
    const prismaContent = safeReadFile(rootPrismaPath);
    const models = parsePrismaSchema(prismaContent, rootPrismaPath);
    dataModels.push(...models);
  }

  // -------------------------------------------------------------------------
  // Auth flows
  // -------------------------------------------------------------------------

  const authFlows = detectAuth(sourceFiles, codebasePath);

  // Summary log (B4)
  const analyzedCount = sourceFiles.length - skippedDueToSize;
  console.log(
    `[qa-agent] Analyzed ${analyzedCount} files (${skippedDueToSize} skipped due to size)`,
  );

  return {
    routes,
    apiEndpoints,
    components,
    forms,
    stateStores,
    businessRules,
    authFlows,
    dataModels,
  };
}
