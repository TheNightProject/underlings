#!/usr/bin/env node
// A hook set up before the app shipped the script under lib/ still names this path, so it runs the same script.
import '../lib/record-artifact.mjs';
