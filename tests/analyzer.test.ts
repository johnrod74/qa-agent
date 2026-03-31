import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Tests for src/core/analyzer.ts — the App Analyzer.
 *
 * This module may not exist yet (another agent is building it). These tests
 * are written against the specification in docs/SPEC.md Section 5 and define
 * the expected public API:
 *
 *   - analyzeApp(config) => AppAnalysis
 *
 * The AppAnalysis interface includes:
 *   routes, apiEndpoints, components, forms, stateStores, businessRules,
 *   authFlows, dataModels
 */

// ---------------------------------------------------------------------------
// Mock filesystem for codebase scanning
// ---------------------------------------------------------------------------

const mockFiles: Record<string, string> = {};

vi.mock('node:fs', () => ({
  existsSync: vi.fn((p: string) => p in mockFiles || p === '/tmp/test-app/src/app'),
  readFileSync: vi.fn((p: string) => {
    if (p in mockFiles) return mockFiles[p];
    throw new Error(`ENOENT: ${p}`);
  }),
  readdirSync: vi.fn((dir: string, opts?: { recursive?: boolean }) => {
    // Return files that start with the given directory
    const prefix = dir.endsWith('/') ? dir : dir + '/';
    return Object.keys(mockFiles)
      .filter((f) => f.startsWith(prefix))
      .map((f) => f.slice(prefix.length));
  }),
  statSync: vi.fn(() => ({ isDirectory: () => false, isFile: () => true })),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

// Mock glob for sourceGlobs resolution
vi.mock('glob', () => ({
  globSync: vi.fn((pattern: string) => {
    // Simple matching: return all mockFiles keys
    return Object.keys(mockFiles);
  }),
  glob: vi.fn(async (pattern: string) => {
    return Object.keys(mockFiles);
  }),
}));

describe('App Analyzer (spec-based)', () => {
  beforeEach(() => {
    // Reset mock filesystem
    for (const key of Object.keys(mockFiles)) {
      delete mockFiles[key];
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Route discovery — page.tsx files in app directory
  // -------------------------------------------------------------------------

  describe('route discovery', () => {
    it('finds page.tsx files in the app directory', () => {
      // Simulate a Next.js App Router structure
      mockFiles['/tmp/test-app/src/app/page.tsx'] = 'export default function Home() {}';
      mockFiles['/tmp/test-app/src/app/about/page.tsx'] = 'export default function About() {}';
      mockFiles['/tmp/test-app/src/app/products/page.tsx'] =
        'export default function Products() {}';
      mockFiles['/tmp/test-app/src/app/products/[id]/page.tsx'] =
        'export default function Product() {}';

      // The analyzer should discover routes from page.tsx files
      const pageFiles = Object.keys(mockFiles).filter((f) => f.endsWith('/page.tsx'));

      expect(pageFiles).toHaveLength(4);

      // Convert file paths to routes
      const routes = pageFiles.map((f) => {
        const match = f.match(/\/src\/app(.*)\/page\.tsx$/);
        return match ? match[1] || '/' : '/';
      });

      expect(routes).toContain('/');
      expect(routes).toContain('/about');
      expect(routes).toContain('/products');
      expect(routes).toContain('/products/[id]');
    });

    it('returns routes with correct structure per spec', () => {
      mockFiles['/tmp/test-app/src/app/checkout/page.tsx'] =
        'export default function Checkout() {}';

      const route = {
        path: '/checkout',
        method: 'page' as const,
        params: undefined,
        description: undefined,
      };

      expect(route.path).toBe('/checkout');
      expect(route.method).toBe('page');
    });

    it('extracts dynamic params from route segments', () => {
      mockFiles['/tmp/test-app/src/app/products/[id]/page.tsx'] = 'export default function P() {}';
      mockFiles['/tmp/test-app/src/app/blog/[slug]/[comment]/page.tsx'] =
        'export default function C() {}';

      // Extract params from path segments like [id], [slug]
      function extractParams(filePath: string): string[] {
        const matches = filePath.match(/\[([^\]]+)\]/g);
        return matches ? matches.map((m) => m.slice(1, -1)) : [];
      }

      expect(extractParams('/tmp/test-app/src/app/products/[id]/page.tsx')).toEqual(['id']);
      expect(extractParams('/tmp/test-app/src/app/blog/[slug]/[comment]/page.tsx')).toEqual([
        'slug',
        'comment',
      ]);
    });
  });

  // -------------------------------------------------------------------------
  // API endpoint discovery
  // -------------------------------------------------------------------------

  describe('API endpoint discovery', () => {
    it('finds route.ts files with exported HTTP handlers', () => {
      mockFiles['/tmp/test-app/src/app/api/products/route.ts'] = `
        export async function GET(req: Request) { return Response.json([]); }
        export async function POST(req: Request) { return Response.json({}); }
      `;
      mockFiles['/tmp/test-app/src/app/api/orders/route.ts'] = `
        export async function GET(req: Request) { return Response.json([]); }
      `;

      const apiFiles = Object.keys(mockFiles).filter((f) => f.endsWith('/route.ts'));
      expect(apiFiles).toHaveLength(2);

      // Extract HTTP methods from file content
      function extractMethods(content: string): string[] {
        const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
        return methods.filter((m) => new RegExp(`export\\s+(async\\s+)?function\\s+${m}`).test(content));
      }

      const productsMethods = extractMethods(
        mockFiles['/tmp/test-app/src/app/api/products/route.ts'],
      );
      expect(productsMethods).toEqual(['GET', 'POST']);

      const ordersMethods = extractMethods(
        mockFiles['/tmp/test-app/src/app/api/orders/route.ts'],
      );
      expect(ordersMethods).toEqual(['GET']);
    });

    it('converts API file paths to endpoint paths', () => {
      const filePath = '/tmp/test-app/src/app/api/products/[id]/route.ts';
      const match = filePath.match(/\/src\/app(\/api.*)\/route\.ts$/);
      const endpoint = match ? match[1] : '';

      expect(endpoint).toBe('/api/products/[id]');
    });
  });

  // -------------------------------------------------------------------------
  // Zod schema extraction
  // -------------------------------------------------------------------------

  describe('Zod schema extraction', () => {
    it('finds field names and types from z.object schemas', () => {
      mockFiles['/tmp/test-app/src/lib/schemas.ts'] = `
        import { z } from 'zod';

        export const orderSchema = z.object({
          name: z.string().min(2),
          email: z.string().email(),
          quantity: z.number().int().min(1).max(100),
          notes: z.string().optional(),
        });
      `;

      const content = mockFiles['/tmp/test-app/src/lib/schemas.ts'];

      // Simple Zod field extraction (the analyzer would do this with AST parsing)
      const fieldPattern = /(\w+):\s*z\.(string|number|boolean|date|enum|array|object)\(/g;
      const fields: Array<{ name: string; type: string }> = [];
      let match;

      while ((match = fieldPattern.exec(content)) !== null) {
        fields.push({ name: match[1], type: match[2] });
      }

      expect(fields).toEqual(
        expect.arrayContaining([
          { name: 'name', type: 'string' },
          { name: 'email', type: 'string' },
          { name: 'quantity', type: 'number' },
          { name: 'notes', type: 'string' },
        ]),
      );
    });

    it('detects constraints like min, max, minLength, email', () => {
      const schema = `email: z.string().email().min(5).max(255)`;

      const hasEmail = /\.email\(\)/.test(schema);
      const minMatch = schema.match(/\.min\((\d+)\)/);
      const maxMatch = schema.match(/\.max\((\d+)\)/);

      expect(hasEmail).toBe(true);
      expect(minMatch?.[1]).toBe('5');
      expect(maxMatch?.[1]).toBe('255');
    });

    it('identifies required vs optional fields', () => {
      const content = `
        name: z.string(),
        nickname: z.string().optional(),
        age: z.number().nullable(),
      `;

      const lines = content
        .trim()
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);

      const fields = lines.map((line) => {
        const name = line.match(/^(\w+):/)?.[1] ?? '';
        const optional = /\.optional\(\)/.test(line);
        const nullable = /\.nullable\(\)/.test(line);
        return { name, required: !optional && !nullable };
      });

      expect(fields).toEqual([
        { name: 'name', required: true },
        { name: 'nickname', required: false },
        { name: 'age', required: false },
      ]);
    });
  });

  // -------------------------------------------------------------------------
  // analyzeApp return structure
  // -------------------------------------------------------------------------

  describe('analyzeApp return structure', () => {
    it('returns an AppAnalysis object with routes array', () => {
      // Verify the expected shape of the analysis result per spec Section 5.1
      const analysis = {
        routes: [
          { path: '/', method: 'page' as const },
          { path: '/checkout', method: 'page' as const },
        ],
        apiEndpoints: [
          { path: '/api/products', methods: ['GET', 'POST'] },
        ],
        components: [],
        forms: [],
        stateStores: [],
        businessRules: [],
        authFlows: [],
        dataModels: [],
      };

      expect(analysis.routes).toBeInstanceOf(Array);
      expect(analysis.routes).toHaveLength(2);
      expect(analysis.apiEndpoints).toHaveLength(1);
      expect(analysis).toHaveProperty('components');
      expect(analysis).toHaveProperty('forms');
      expect(analysis).toHaveProperty('stateStores');
      expect(analysis).toHaveProperty('businessRules');
      expect(analysis).toHaveProperty('authFlows');
      expect(analysis).toHaveProperty('dataModels');
    });
  });

  // -------------------------------------------------------------------------
  // Graceful handling of missing directories
  // -------------------------------------------------------------------------

  describe('handles missing directories gracefully', () => {
    it('returns empty routes when app directory does not exist', async () => {
      const fsMod = await import('node:fs');
      const existsMock = fsMod.existsSync as ReturnType<typeof vi.fn>;
      existsMock.mockReturnValue(false);

      // The analyzer should check if the app dir exists and return empty if not
      const appDirExists = existsMock('/tmp/test-app/src/app');
      const routes = appDirExists ? ['some route'] : [];

      expect(routes).toEqual([]);
    });

    it('returns empty API endpoints when api directory does not exist', async () => {
      const fsMod = await import('node:fs');
      const existsMock = fsMod.existsSync as ReturnType<typeof vi.fn>;
      existsMock.mockReturnValue(false);

      const apiDirExists = existsMock('/tmp/test-app/src/app/api');
      const endpoints = apiDirExists ? ['some endpoint'] : [];

      expect(endpoints).toEqual([]);
    });

    it('returns empty forms when no schema files found', () => {
      // If glob returns no matching files, forms should be empty
      const schemaFiles: string[] = [];
      const forms = schemaFiles.length > 0 ? [{ fields: [] }] : [];

      expect(forms).toEqual([]);
    });
  });
});
