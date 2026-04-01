import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Tests for src/core/dom-discovery.ts — DOM Discovery module.
 *
 * Mocks Playwright's browser/page to verify that discoverPages:
 * 1. Returns the correct PageDiscovery[] structure
 * 2. Handles unreachable pages gracefully
 */

// ---------------------------------------------------------------------------
// Mock Playwright — vi.mock is hoisted, so use vi.hoisted for shared state
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => {
  const mockEvaluateResult = {
    headings: [{ role: 'heading', name: 'Welcome' }],
    buttons: [{ role: 'button', name: 'Submit' }],
    links: [{ role: 'link', name: 'Home' }],
    inputs: [{ role: 'textbox', name: 'Email' }],
    forms: [
      {
        name: 'contact-form',
        fields: [{ role: 'textbox', name: 'Email' }],
      },
    ],
  };

  const mockPage = {
    goto: vi.fn().mockResolvedValue(undefined),
    title: vi.fn().mockResolvedValue('Test Page'),
    evaluate: vi.fn().mockResolvedValue(mockEvaluateResult),
  };

  const mockContext = {
    newPage: vi.fn().mockResolvedValue(mockPage),
    close: vi.fn(),
  };

  const mockBrowser = {
    newContext: vi.fn().mockResolvedValue(mockContext),
    close: vi.fn(),
  };

  const mockWriteFileSafe = vi.fn();

  return { mockEvaluateResult, mockPage, mockContext, mockBrowser, mockWriteFileSafe };
});

vi.mock('@playwright/test', () => ({
  chromium: {
    launch: vi.fn().mockResolvedValue(mocks.mockBrowser),
  },
}));

vi.mock('../src/core/fs-utils.js', () => ({
  writeFileSafe: mocks.mockWriteFileSafe,
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { discoverPages } from '../src/core/dom-discovery.js';
import type { PageDiscovery } from '../src/core/dom-discovery.js';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dom-discovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.mockPage.goto.mockResolvedValue(undefined);
    mocks.mockPage.title.mockResolvedValue('Test Page');
    mocks.mockPage.evaluate.mockResolvedValue(mocks.mockEvaluateResult);
    mocks.mockBrowser.newContext.mockResolvedValue(mocks.mockContext);
    mocks.mockContext.newPage.mockResolvedValue(mocks.mockPage);
  });

  it('returns correct PageDiscovery[] structure for reachable pages', async () => {
    const result: PageDiscovery[] = await discoverPages({
      baseUrl: 'http://localhost:3000',
      routes: [
        { path: '/', method: 'page' },
        { path: '/about', method: 'page' },
      ],
      plansDir: '/tmp/plans',
    });

    expect(result).toHaveLength(2);

    // Check first page structure
    const page1 = result[0];
    expect(page1.path).toBe('/');
    expect(page1.title).toBe('Test Page');

    // Headings
    expect(page1.headings).toHaveLength(1);
    expect(page1.headings[0]).toMatchObject({
      role: 'heading',
      name: 'Welcome',
      selector: expect.stringContaining('getByRole'),
    });

    // Buttons
    expect(page1.buttons).toHaveLength(1);
    expect(page1.buttons[0]).toMatchObject({
      role: 'button',
      name: 'Submit',
      selector: "getByRole('button', { name: 'Submit' })",
    });

    // Links
    expect(page1.links).toHaveLength(1);
    expect(page1.links[0].role).toBe('link');

    // Inputs
    expect(page1.inputs).toHaveLength(1);
    expect(page1.inputs[0]).toMatchObject({
      role: 'textbox',
      name: 'Email',
    });

    // Forms
    expect(page1.forms).toHaveLength(1);
    expect(page1.forms[0].name).toBe('contact-form');
    expect(page1.forms[0].fields).toHaveLength(1);
  });

  it('skips API routes and parameterised routes', async () => {
    const result = await discoverPages({
      baseUrl: 'http://localhost:3000',
      routes: [
        { path: '/', method: 'page' },
        { path: '/api/users', method: 'api' },
        { path: '/products/[id]', method: 'page', params: ['id'] },
      ],
      plansDir: '/tmp/plans',
    });

    // Only the root page should be discovered
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe('/');
  });

  it('handles unreachable pages gracefully', async () => {
    mocks.mockPage.goto.mockRejectedValueOnce(new Error('net::ERR_CONNECTION_REFUSED'));

    const result = await discoverPages({
      baseUrl: 'http://localhost:3000',
      routes: [{ path: '/broken', method: 'page' }],
      plansDir: '/tmp/plans',
    });

    expect(result).toHaveLength(1);
    expect(result[0].path).toBe('/broken');
    expect(result[0].title).toBe('[unreachable]');
    expect(result[0].headings).toEqual([]);
    expect(result[0].buttons).toEqual([]);
    expect(result[0].links).toEqual([]);
    expect(result[0].inputs).toEqual([]);
    expect(result[0].forms).toEqual([]);
  });

  it('closes browser even when discovery fails', async () => {
    mocks.mockPage.goto.mockRejectedValue(new Error('timeout'));

    await discoverPages({
      baseUrl: 'http://localhost:3000',
      routes: [{ path: '/', method: 'page' }],
      plansDir: '/tmp/plans',
    });

    expect(mocks.mockBrowser.close).toHaveBeenCalledOnce();
  });

  it('saves discovery results to plans/dom-discovery.json', async () => {
    await discoverPages({
      baseUrl: 'http://localhost:3000',
      routes: [{ path: '/', method: 'page' }],
      plansDir: '/tmp/plans',
    });

    expect(mocks.mockWriteFileSafe).toHaveBeenCalledWith(
      '/tmp/plans/dom-discovery.json',
      expect.any(String),
    );

    // Verify the JSON is valid
    const jsonArg = mocks.mockWriteFileSafe.mock.calls[0][1] as string;
    const parsed = JSON.parse(jsonArg);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].path).toBe('/');
  });

  it('passes storageState to browser context when provided', async () => {
    await discoverPages({
      baseUrl: 'http://localhost:3000',
      routes: [{ path: '/', method: 'page' }],
      plansDir: '/tmp/plans',
      storageState: '/tmp/auth/admin.json',
    });

    expect(mocks.mockBrowser.newContext).toHaveBeenCalledWith(
      expect.objectContaining({ storageState: '/tmp/auth/admin.json' }),
    );
  });
});
