import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

/**
 * Write one file without exposing a partially written destination file.
 *
 * The temporary file is created next to the destination so the final rename
 * remains on the same filesystem.
 *
 * @param {string} destination
 * @param {string | Uint8Array} contents
 * @param {{ mode?: number }} [options]
 */
export async function writeFileAtomically(destination, contents, options = {}) {
  const directory = dirname(destination);
  const temporary = join(
    directory,
    `.${basename(destination)}.${process.pid}.${randomUUID()}.tmp`,
  );

  await mkdir(directory, { recursive: true });

  try {
    await writeFile(temporary, contents, {
      encoding: typeof contents === 'string' ? 'utf8' : undefined,
      flag: 'wx',
      mode: options.mode,
    });
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

/**
 * @param {string} destination
 * @param {unknown} value
 */
export async function writeJsonAtomically(destination, value) {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  await writeFileAtomically(destination, serialized);
}

async function writeChunk(file, chunk) {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await file.write(chunk, offset, chunk.byteLength - offset);
    if (bytesWritten === 0) {
      throw new Error('Could not write downloaded file contents.');
    }
    offset += bytesWritten;
  }
}

/**
 * Persist a WHATWG ReadableStream without buffering the whole file in memory.
 * A failed or incomplete stream never replaces an existing destination file.
 *
 * @param {string} destination
 * @param {ReadableStream<Uint8Array>} stream
 * @param {{ mode?: number }} [options]
 */
export async function writeWebStreamAtomically(destination, stream, options = {}) {
  if (!stream || typeof stream.getReader !== 'function') {
    throw new TypeError('A WHATWG ReadableStream is required.');
  }

  const directory = dirname(destination);
  const temporary = join(
    directory,
    `.${basename(destination)}.${process.pid}.${randomUUID()}.tmp`,
  );
  await mkdir(directory, { recursive: true });

  const file = await open(temporary, 'wx', options.mode);
  const reader = stream.getReader();
  let renamed = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!(value instanceof Uint8Array)) {
        throw new TypeError('Download stream must contain Uint8Array chunks.');
      }
      await writeChunk(file, value);
    }

    await file.sync();
    await file.close();
    await rename(temporary, destination);
    renamed = true;
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
    await file.close().catch(() => {});
    if (!renamed) {
      await rm(temporary, { force: true }).catch(() => {});
    }
  }
}
