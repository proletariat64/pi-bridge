#!/usr/bin/env bun

import { createInterface } from "node:readline/promises";
import { formatRuntimeStatus, inspectRuntime } from "../runtime.js";
import {
	formatDoctorReport,
	formatSmokeTestReport,
	runDoctor,
	runSmokeTest,
} from "../operations.js";

interface ParsedArguments {
	command?: string;
	worker?: string;
	yes?: boolean;
	error?: string;
}

function parseArguments(arguments_: string[]): ParsedArguments {
	const parsed: ParsedArguments = { yes: false };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--worker") {
      const worker = arguments_[index + 1];
      if (!worker || worker.startsWith("--")) return { error: "--worker requires a name" };
      parsed.worker = worker;
      index += 1;
			continue;
		}
		if (argument === "--yes") {
			parsed.yes = true;
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
	if (arguments_.command === "status") {
		if (arguments_.yes) {
			console.error("--yes is only valid with smoke-test");
			return 2;
		}
		const status = await inspectRuntime({ mode: "cli", worker: arguments_.worker });
		console.log(formatRuntimeStatus(status));
		return status.selectionRequired ? 2 : 0;
	}
	if (arguments_.command === "doctor") {
		if (arguments_.yes) {
			console.error("--yes is only valid with smoke-test");
			return 2;
		}
		const report = await runDoctor({ mode: "cli", worker: arguments_.worker });
		console.log(formatDoctorReport(report));
		return report.ok ? 0 : 1;
	}
	if (arguments_.command === "smoke-test") {
		let confirmed = arguments_.yes;
		if (!confirmed) {
			const prompt = createInterface({ input: process.stdin, output: process.stderr });
			try {
				const answer = await prompt.question(
					"This writes permanent isolated Claude-mem smoke records. Continue? [y/N] ",
				);
				confirmed = ["y", "yes"].includes(answer.trim().toLowerCase());
			} finally {
				prompt.close();
			}
		}
		if (!confirmed) {
			console.log("Smoke test cancelled; no worker writes were sent.");
			return 2;
		}
		const report = await runSmokeTest({
			mode: "cli",
			worker: arguments_.worker,
		});
		console.log(formatSmokeTestReport(report));
		return report.ok ? 0 : 1;
	}
	console.error(
		"Usage: pi-claude-mem <status|doctor|smoke-test> [--worker <name>] [--yes]",
	);
	return 2;
}

process.exitCode = await main();
