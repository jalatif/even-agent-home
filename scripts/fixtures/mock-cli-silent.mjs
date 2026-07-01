#!/usr/bin/env node
/**
 * Mock CLI for test-cli-provider.mjs (silent-failure case). Writes a benign
 * message to stderr and exits with code 0, emitting NO assistant text and NO
 * result marker. The provider must treat this as a failure.
 */
process.stderr.write("No API key found for model\n");
process.exit(0);
