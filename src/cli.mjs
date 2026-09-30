#!/usr/bin/env node

import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

import { ArchiveFormatError } from './archive/format.mjs';
import { collectArchive } from './archive/collector.mjs';
import { renderCollectionReport } from './archive/report.mjs';
import { renderArchive } from './archive/render.mjs';
import { initializeArchive, verifyArchive } from './archive/session.mjs';
import { verifyRuntimeFile } from './backlog/runtime.mjs';

const VERSION = '0.1.0';

const USAGE = `Usage:
  miku-backlog-archive init --output <directory> --source-domain <domain> --project-key <key>
  miku-backlog-archive verify --output <directory>
  miku-backlog-archive runtime verify --runtime <file>
  miku-backlog-archive collect --archive <directory> --runtime <file>
  miku-backlog-archive render --archive <directory>
  miku-backlog-archive report --archive <directory>

Commands:
  init    Create an empty archive workspace. It does not contact Backlog.
  verify  Check the local archive layout and its manifest/progress pairing.
  runtime verify  Validate the fixed miku-backlog-api Runtime without contacting Backlog.
  collect  Collect project, issue, Wiki, and file data into an initialized archive.
  render  Generate static HTML from a completed archive without contacting Backlog.
  report  Generate an offline collection-status report, including incomplete archives.

Options:
  -o, --output <directory>       Archive output directory
  --source-domain <domain>       Backlog domain, such as example.backlog.com
  --project-key <key>            Backlog project key
  --runtime <file>               Downloaded miku-backlog-api Runtime file
  --archive <directory>          Initialized archive directory
  -h, --help                     Show this help
  --version                      Show the version
`;

function requireOption(options, name) {
  const value = options[name];
  if (!value) {
    throw new ArchiveFormatError(`Missing required option: --${name}.`);
  }
  return value;
}

function parseOptions(arguments_, allowedNames) {
  const options = {};
  for (let index = 0; index < arguments_.length; index += 1) {
    const option = arguments_[index];
    if (option === '--help' || option === '-h') {
      return { help: true };
    }

    const name = option === '-o' ? 'output' : option?.replace(/^--/, '');
    if (!option?.startsWith('-') || !allowedNames.includes(name)) {
      throw new ArchiveFormatError(`Unknown option: ${option}.`);
    }
    if (Object.hasOwn(options, name)) {
      throw new ArchiveFormatError(`Option may be specified once only: ${option}.`);
    }

    const value = arguments_[index + 1];
    if (!value || value.startsWith('-')) {
      throw new ArchiveFormatError(`Option requires a value: ${option}.`);
    }
    options[name] = value;
    index += 1;
  }
  return options;
}

/**
 * @param {string[]} argv
 */
export function parseCommand(argv) {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    return { type: 'help' };
  }
  if (argv[0] === '--version') {
    return { type: 'version' };
  }

  const [command, ...arguments_] = argv;
  if (!['init', 'verify', 'runtime', 'collect', 'render', 'report'].includes(command)) {
    throw new ArchiveFormatError(`Unknown command: ${command}.`);
  }

  if (command === 'runtime') {
    const [runtimeCommand, ...runtimeArguments] = arguments_;
    if (runtimeCommand !== 'verify') {
      throw new ArchiveFormatError(`Unknown runtime command: ${String(runtimeCommand)}.`);
    }
    const options = parseOptions(runtimeArguments, ['runtime']);
    if (options.help) {
      return { type: 'help' };
    }
    return { type: 'runtime-verify', runtimePath: requireOption(options, 'runtime') };
  }

  const options = parseOptions(
    arguments_,
    command === 'init'
      ? ['output', 'source-domain', 'project-key']
      : command === 'collect'
        ? ['archive', 'runtime']
        : command === 'render' || command === 'report'
          ? ['archive']
        : ['output'],
  );
  if (options.help) {
    return { type: 'help' };
  }

  if (command === 'init') {
    return {
      type: 'init',
      output: requireOption(options, 'output'),
      domain: requireOption(options, 'source-domain'),
      projectKey: requireOption(options, 'project-key'),
    };
  }

  if (command === 'collect') {
    return {
      type: 'collect',
      output: requireOption(options, 'archive'),
      runtimePath: requireOption(options, 'runtime'),
    };
  }

  if (command === 'render' || command === 'report') {
    return {
      type: command,
      output: requireOption(options, 'archive'),
    };
  }

  return { type: 'verify', output: requireOption(options, 'output') };
}

/**
 * @param {string[]} argv
 * @param {{ stdout?: { write(value: string): unknown }, stderr?: { write(value: string): unknown } }} [io]
 */
export async function main(argv, io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;

  try {
    const command = parseCommand(argv);
    if (command.type === 'help') {
      stdout.write(USAGE);
      return 0;
    }
    if (command.type === 'version') {
      stdout.write(`${VERSION}\n`);
      return 0;
    }
    if (command.type === 'init') {
      const { paths, manifest } = await initializeArchive({
        output: command.output,
        domain: command.domain,
        projectKey: command.projectKey,
        toolVersion: VERSION,
      });
      stdout.write(
        `Initialized archive for ${manifest.source.project.key} at ${paths.root}\n`,
      );
      return 0;
    }
    if (command.type === 'runtime-verify') {
      const runtime = await verifyRuntimeFile(command.runtimePath);
      stdout.write(
        `Runtime is compatible: ${runtime.product.name} ${runtime.product.version}, ${runtime.operationCount} operations, sha256=${runtime.sha256}\n`,
      );
      return 0;
    }
    if (command.type === 'collect') {
      const result = await collectArchive({
        output: command.output,
        runtimePath: command.runtimePath,
      });
      stdout.write(
        `Collection completed: projectId=${result.projectId}, issues=${result.issueCount} (new ${result.collectedIssueCount}), wikis=${result.wikiCount} (new ${result.collectedWikiCount}), sharedFiles=${result.sharedFileCount}, assets=${result.assetCount} (new ${result.collectedAssetCount})\n`,
      );
      return 0;
    }
    if (command.type === 'render') {
      const result = await renderArchive({ output: command.output });
      stdout.write(
        `Rendered site: issues=${result.issueCount}, wikis=${result.wikiCount}, sharedFiles=${result.sharedFileCount}\n`,
      );
      return 0;
    }
    if (command.type === 'report') {
      const result = await renderCollectionReport({ output: command.output });
      stdout.write(
        `Rendered collection report: status=${result.collectionStatus ?? '—'}, phase=${result.phase}, failedTasks=${result.failedTaskCount}, path=${result.path}\n`,
      );
      return 0;
    }

    const { paths, manifest, progress } = await verifyArchive(command.output);
    stdout.write(
      `Archive is valid: ${manifest.source.project.key} (${manifest.source.domain}), phase=${progress.phase}, path=${paths.root}\n`,
    );
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(`miku-backlog-archive: ${message}\n`);
    return 1;
  }
}

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  const exitCode = await main(process.argv.slice(2));
  if (exitCode !== 0) {
    process.exitCode = exitCode;
  }
}
