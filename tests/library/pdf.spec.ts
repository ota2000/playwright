/**
 * Copyright 2017 Google Inc. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { browserTest as it, expect } from '../config/browserTest';
import fs from 'fs';

it('should be able to save file', async ({ contextFactory, browserName }, testInfo) => {
  it.skip(browserName !== 'chromium', 'Printing to pdf is currently only supported in chromium.');
  const context = await contextFactory();
  const page = await context.newPage();
  const outputFile = testInfo.outputPath('output.pdf');
  await page.pdf({ path: outputFile });
  expect(fs.readFileSync(outputFile).byteLength).toBeGreaterThan(0);
});

it('should be able to generate outline', async ({ contextFactory, server, browserName }, testInfo) => {
  it.skip(browserName !== 'chromium', 'Printing to pdf is currently only supported in chromium.');
  const context = await contextFactory({
    baseURL: server.PREFIX,
  });
  const page = await context.newPage();
  await page.goto('/headings.html');
  const outputFileNoOutline = testInfo.outputPath('outputNoOutline.pdf');
  const outputFileOutline = testInfo.outputPath('outputOutline.pdf');
  await page.pdf({ path: outputFileNoOutline });
  await page.pdf({ path: outputFileOutline, tagged: true, outline: true });
  expect(fs.readFileSync(outputFileOutline).byteLength).toBeGreaterThan(fs.readFileSync(outputFileNoOutline).byteLength);
});

it('should generate clipped pdf', async ({ contextFactory, browserName }) => {
  it.skip(browserName !== 'chromium', 'Printing to pdf is currently only supported in chromium.');
  const context = await contextFactory();
  const page = await context.newPage();
  await page.setContent('<div style="width: 200px; height: 200px; background: red;"></div>');
  const clippedPdf = await page.pdf({ clip: { x: 0, y: 0, width: 200, height: 200 } });
  expect(clippedPdf.byteLength).toBeGreaterThan(0);
  // Verify the MediaBox was cropped to 150x150 points (200px * 72/96).
  // Use the last MediaBox match since incremental updates append to the end.
  const pdfText = clippedPdf.toString('binary');
  const mediaBoxes = [...pdfText.matchAll(/\/MediaBox\s*\[([^\]]+)\]/g)];
  expect(mediaBoxes.length).toBeGreaterThan(0);
  const [llx, lly, urx, ury] = mediaBoxes[mediaBoxes.length - 1][1].trim().split(/\s+/).map(Number);
  expect(urx - llx).toBeCloseTo(150, 0);
  expect(ury - lly).toBeCloseTo(150, 0);
});

it('should clip with offset', async ({ contextFactory, browserName }) => {
  it.skip(browserName !== 'chromium', 'Printing to pdf is currently only supported in chromium.');
  const context = await contextFactory();
  const page = await context.newPage();
  await page.setContent('<div style="margin: 100px; width: 200px; height: 200px; background: blue;"></div>');
  const clippedPdf = await page.pdf({ clip: { x: 100, y: 100, width: 200, height: 200 } });
  expect(clippedPdf.byteLength).toBeGreaterThan(0);
  // Verify the MediaBox offset is non-zero (x=75pt from clip.x=100px).
  const pdfText = clippedPdf.toString('binary');
  const mediaBoxes = [...pdfText.matchAll(/\/MediaBox\s*\[([^\]]+)\]/g)];
  expect(mediaBoxes.length).toBeGreaterThan(0);
  const [llx] = mediaBoxes[mediaBoxes.length - 1][1].trim().split(/\s+/).map(Number);
  expect(llx).toBeCloseTo(75, 0);
});

it('should clip with printBackground', async ({ contextFactory, browserName }) => {
  it.skip(browserName !== 'chromium', 'Printing to pdf is currently only supported in chromium.');
  const context = await contextFactory();
  const page = await context.newPage();
  await page.setContent('<div style="width: 500px; height: 500px; background: green;"></div>');
  const clippedPdf = await page.pdf({
    clip: { x: 0, y: 0, width: 250, height: 250 },
    printBackground: true,
  });
  expect(clippedPdf.byteLength).toBeGreaterThan(0);
});
