import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { screen } from 'electron';

import type { SnapshotRecord } from '../../shared/types.js';
import {
  CAPTURE_JPEG_DOWNSAMPLE_ENABLED,
  CAPTURE_JPEG_MAX_LONG_EDGE_PX,
  CAPTURE_JPEG_SIPS_QUALITY,
} from './defaults.js';
import { hashBuffer } from './utils.js';

const execFileAsync = promisify(execFile);

function parseSipsPixelOutput(stdout: string): { width: number; height: number } | null {
  const wMatch = /pixelWidth:\s*(\d+)/.exec(stdout);
  const hMatch = /pixelHeight:\s*(\d+)/.exec(stdout);
  if (!wMatch || !hMatch) return null;
  return { width: Number(wMatch[1]), height: Number(hMatch[1]) };
}

async function getSipsPixelDimensions(filePath: string): Promise<{ width: number; height: number } | null> {
  if (process.platform !== 'darwin') return null;
  try {
    const { stdout } = await execFileAsync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', filePath]);
    return parseSipsPixelOutput(stdout);
  } catch {
    return null;
  }
}

/**
 * In-place JPEG downsample via macOS `sips` (no extra native deps). On failure or non-mac, leaves the file unchanged.
 */
async function downsampleCaptureJpegInPlace(filePath: string): Promise<void> {
  if (!CAPTURE_JPEG_DOWNSAMPLE_ENABLED) return;
  if (process.platform !== 'darwin') return;

  let statBefore: Awaited<ReturnType<typeof fs.stat>>;
  try {
    statBefore = await fs.stat(filePath);
  } catch {
    return;
  }

  const dimsBefore = await getSipsPixelDimensions(filePath);
  const label = `myloggy:capture:sips-resize:${path.basename(filePath)}`;
  console.time(label);
  try {
    await execFileAsync('sips', [
      '-Z',
      String(CAPTURE_JPEG_MAX_LONG_EDGE_PX),
      '-s',
      'formatOptions',
      String(CAPTURE_JPEG_SIPS_QUALITY),
      filePath,
    ]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`myloggy: sips resize failed (using original capture): ${message}`);
    return;
  } finally {
    console.timeEnd(label);
  }

  try {
    const statAfter = await fs.stat(filePath);
    const dimsAfter = await getSipsPixelDimensions(filePath);
    const beforeDim =
      dimsBefore != null ? `${dimsBefore.width}x${dimsBefore.height}` : 'unknown';
    const afterDim = dimsAfter != null ? `${dimsAfter.width}x${dimsAfter.height}` : 'unknown';
    console.log(
      `myloggy: capture jpeg ${path.basename(filePath)}: ${beforeDim} ${statBefore.size}b -> ${afterDim} ${statAfter.size}b`,
    );
  } catch {
    // Debug logging only; ignore.
  }
}

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
      await downsampleCaptureJpegInPlace(filePath);
      const buffer = await fs.readFile(filePath);
      imagePaths.push(filePath);
      imageHashes.push(hashBuffer(buffer));
    } else {
      try {
        await execFileAsync('screencapture', ['-x', '-D', String(displayIndex), '-t', 'jpg', filePath]);
        await downsampleCaptureJpegInPlace(filePath);
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
