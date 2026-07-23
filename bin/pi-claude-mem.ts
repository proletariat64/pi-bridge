#!/usr/bin/env bun

import { formatRuntimeStatus, inspectRuntime } from "../runtime.js";

interface ParsedArguments {
  command?: string;
  worker?: string;
  error?: string;
}

function parseArguments(arguments_: string[]): ParsedArguments {
  const parsed: ParsedArguments = {};
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--worker") {
      const worker = arguments_[index + 1];
      if (!worker || worker.startsWith("--")) return { error: "--worker requires a name" };
      parsed.worker = worker;
      index += 1;
      continue;
    }
    if (argument.startsWith("--")) return { error: `unknown option ${argument}` };
    if (parsed.command) return { error: `unexpected argument ${argument}` };
    parsed.command = argument;
  }
  return parsed;
}

async function main(): Promise<number> {
  const arguments_ = parseArguments(process.argv.slice(2));
  if (arguments_.error) {
    console.error(arguments_.error);
    return 2;
  }
  if (arguments_.command !== "status") {
    console.error("Usage: pi-claude-mem status [--worker <name>]");
    return 2;
  }

  const status = await inspectRuntime({ mode: "cli", worker: arguments_.worker });
  console.log(formatRuntimeStatus(status));
  return status.selectionRequired ? 2 : 0;
}

process.exitCode = await main();
