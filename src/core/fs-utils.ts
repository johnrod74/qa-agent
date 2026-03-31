/**
 * Shared file-system utilities — safe read and safe write helpers used
 * across multiple modules.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Read a file and return its content as a UTF-8 string.
 * Returns an empty string if the file cannot be read.
 */
export function safeReadFile(filePath: string): string {
  try {
    return readFileSync(filePath, 'utf-8');
  } catch {
    return '';
  }
}

/**
 * Write content to a file, creating parent directories as needed.
 */
export function writeFileSafe(filePath: string, content: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, 'utf-8');
}
