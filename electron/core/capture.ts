import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { screen } from 'electron';

import type { SnapshotRecord } from '../../shared/types.js';
import { hashBuffer } from './utils.js';

const execFileAsync = promisify(execFile);

export interface CaptureResult {
  imagePath: string | null;
  imageHash: string | null;
  imagePaths: string[];
  imageHashes: string[];
  displayCount: number;
}

export async function captureScreenshot(
  tempDir: string,
  snapshotId: string,
  mode: 'main' | 'all',
): Promise<CaptureResult> {
  await fs.mkdir(tempDir, { recursive: true });
  const displayCount = Math.max(1, screen.getAllDisplays().length);
  const targets = mode === 'main' ? [1] : Array.from({ length: displayCount }, (_, index) => index + 1);
  const imagePaths: string[] = [];
  const imageHashes: string[] = [];

  for (const displayIndex of targets) {
    const filePath = path.join(tempDir, `${snapshotId}-display-${displayIndex}.jpg`);
    if (mode === 'main') {
      await execFileAsync('screencapture', ['-x', '-D', String(displayIndex), '-t', 'jpg', filePath]);
      const buffer = await fs.readFile(filePath);
      imagePaths.push(filePath);
      imageHashes.push(hashBuffer(buffer));
    } else {
      try {
        await execFileAsync('screencapture', ['-x', '-D', String(displayIndex), '-t', 'jpg', filePath]);
        const buffer = await fs.readFile(filePath);
        imagePaths.push(filePath);
        imageHashes.push(hashBuffer(buffer));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`myloggy: capture skipped display ${displayIndex}: ${message}`);
      }
    }
  }

  if (mode === 'all' && imagePaths.length === 0) {
    throw new Error('All display captures failed');
  }

  return {
    imagePath: imagePaths[0] ?? null,
    imageHash: imageHashes[0] ?? null,
    imagePaths,
    imageHashes,
    displayCount,
  };
}

export async function deleteScreenshots(snapshots: SnapshotRecord[]): Promise<void> {
  await Promise.all(
    snapshots
      .flatMap((snapshot) => (snapshot.imagePaths.length ? snapshot.imagePaths : snapshot.imagePath ? [snapshot.imagePath] : []))
      .map(async (filePath) => {
        try {
          await fs.unlink(filePath);
        } catch {
          // Ignore already removed files.
        }
      }),
  );
}
