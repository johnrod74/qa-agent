# QA Agent

An autonomous, AI-driven end-to-end testing system that explores web applications, discovers bugs, and files GitHub Issues — then coordinates fix agents to resolve them.

## How It Works

1. **Point it at a codebase + spec** — the agent learns the app's structure, routes, and business rules
2. **It generates and runs Playwright tests** against your localhost
3. **Failures become GitHub Issues** — with steps to reproduce, screenshots, and expected vs actual
4. **Fix agents work bugs in parallel** — using git worktrees for isolation
5. **A validation agent re-runs tests** to confirm fixes and catch regressions

## Quick Start

```bash
# Install
npm install

# Configure (point to your app)
cp .env.example .env
# Edit .env with your app's details

# Run the full QA cycle
npx qa-agent run

# Or run individual phases
npx qa-agent plan      # Generate test plan from specs
npx qa-agent generate  # Generate Playwright tests from plan
npx qa-agent test      # Run tests, file issues for failures
npx qa-agent fix       # Launch fix agents for open issues
npx qa-agent validate  # Re-run tests to verify fixes
```

## Architecture

See [docs/SPEC.md](docs/SPEC.md) for the full system specification.
