/**
 * Copyright 2017 Google Inc. All rights reserved.
 * Modifications copyright (c) Microsoft Corporation.
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

import { readProtocolStream } from './crProtocolHelper';
import { assert } from '../../utils';

import type { CRSession } from './crConnection';
import type * as channels from '@protocol/channels';

const PagePaperFormats: { [key: string]: { width: number, height: number }} = {
  letter: { width: 8.5, height: 11 },
  legal: { width: 8.5, height: 14 },
  tabloid: { width: 11, height: 17 },
  ledger: { width: 17, height: 11 },
  a0: { width: 33.1, height: 46.8 },
  a1: { width: 23.4, height: 33.1 },
  a2: { width: 16.54, height: 23.4 },
  a3: { width: 11.7, height: 16.54 },
  a4: { width: 8.27, height: 11.7 },
  a5: { width: 5.83, height: 8.27 },
  a6: { width: 4.13, height: 5.83 },
};

const unitToPixels: { [key: string]: number } = {
  'px': 1,
  'in': 96,
  'cm': 37.8,
  'mm': 3.78
};

function convertPrintParameterToInches(text: string | undefined): number | undefined {
  if (text === undefined)
    return undefined;
  let unit = text.substring(text.length - 2).toLowerCase();
  let valueText = '';
  if (unitToPixels.hasOwnProperty(unit)) {
    valueText = text.substring(0, text.length - 2);
  } else {
    // In case of unknown unit try to parse the whole parameter as number of pixels.
    // This is consistent with phantom's paperSize behavior.
    unit = 'px';
    valueText = text;
  }
  const value = Number(valueText);
  assert(!isNaN(value), 'Failed to parse parameter value: ' + text);
  const pixels = value * unitToPixels[unit];
  return pixels / 96;
}

export class CRPDF {
  private _client: CRSession;

  constructor(client: CRSession) {
    this._client = client;
  }

  async generate(options: channels.PagePdfParams): Promise<Buffer> {
    const {
      scale = 1,
      displayHeaderFooter = false,
      headerTemplate = '',
      footerTemplate = '',
      printBackground = false,
      landscape = false,
      pageRanges = '',
      preferCSSPageSize = false,
      margin = {},
      tagged = false,
      outline = false,
      clip,
    } = options;

    let paperWidth = 8.5;
    let paperHeight = 11;
    if (options.format) {
      const format = PagePaperFormats[options.format.toLowerCase()];
      assert(format, 'Unknown paper format: ' + options.format);
      paperWidth = format.width;
      paperHeight = format.height;
    } else {
      paperWidth = convertPrintParameterToInches(options.width) || paperWidth;
      paperHeight = convertPrintParameterToInches(options.height) || paperHeight;
    }

    if (clip) {
      // When clipping, use a page size large enough to contain the clip area
      // so that the print layout matches the screen layout.
      const requiredWidth = (clip.x + clip.width) / 96;
      const requiredHeight = (clip.y + clip.height) / 96;
      paperWidth = Math.max(paperWidth, requiredWidth);
      paperHeight = Math.max(paperHeight, requiredHeight);
    }

    const marginTop = convertPrintParameterToInches(margin.top) || 0;
    const marginLeft = convertPrintParameterToInches(margin.left) || 0;
    const marginBottom = convertPrintParameterToInches(margin.bottom) || 0;
    const marginRight = convertPrintParameterToInches(margin.right) || 0;
    const generateDocumentOutline = outline;
    const generateTaggedPDF = tagged;
    const result = await this._client.send('Page.printToPDF', {
      transferMode: 'ReturnAsStream',
      landscape,
      displayHeaderFooter,
      headerTemplate,
      footerTemplate,
      printBackground,
      scale,
      paperWidth,
      paperHeight,
      marginTop,
      marginBottom,
      marginLeft,
      marginRight,
      pageRanges: clip ? '1' : pageRanges,
      preferCSSPageSize,
      generateTaggedPDF,
      generateDocumentOutline
    });
    let buffer = await readProtocolStream(this._client, result.stream!);

    if (clip)
      buffer = cropPdfViaIncrementalUpdate(buffer, clip, paperHeight * 72);

    return buffer;
  }
}

/**
 * Crops a PDF to the given clip area using a PDF incremental update.
 * Instead of modifying existing bytes, a new Page object with the updated
 * MediaBox is appended to the PDF along with a new xref section and trailer.
 * This is the standard PDF mechanism for modifications and avoids invalidating
 * existing xref offsets.
 */
function cropPdfViaIncrementalUpdate(
  buffer: Buffer,
  clip: { x: number, y: number, width: number, height: number },
  pageHeightPt: number
): Buffer {
  const pxToPt = 72 / 96;
  // PDF coordinate system: origin at bottom-left, Y axis points up.
  const llx = clip.x * pxToPt;
  const lly = pageHeightPt - (clip.y + clip.height) * pxToPt;
  const urx = (clip.x + clip.width) * pxToPt;
  const ury = pageHeightPt - clip.y * pxToPt;
  const newMediaBox = `[${llx.toFixed(2)} ${lly.toFixed(2)} ${urx.toFixed(2)} ${ury.toFixed(2)}]`;

  const pdfStr = buffer.toString('binary');

  // 1. Find the previous xref offset from startxref.
  const startxrefIdx = pdfStr.lastIndexOf('startxref');
  if (startxrefIdx === -1)
    return buffer;
  const newlineAfter = pdfStr.indexOf('\n', startxrefIdx + 10);
  const prevXrefOffset = parseInt(pdfStr.substring(startxrefIdx + 10, newlineAfter), 10);

  // 2. Find the Page object (match "/Type /Page" but not "/Type /Pages").
  let pageObjNum = -1;
  let pageObjContent = '';
  let searchPos = 0;
  while (searchPos < pdfStr.length) {
    const objIdx = pdfStr.indexOf(' 0 obj\n', searchPos);
    if (objIdx === -1)
      break;

    // Extract object number from before " 0 obj\n".
    const lineStart = pdfStr.lastIndexOf('\n', objIdx - 1) + 1;
    const objNumStr = pdfStr.substring(lineStart, objIdx);
    const endObjIdx = pdfStr.indexOf('endobj', objIdx);
    if (endObjIdx === -1) {
      searchPos = objIdx + 7;
      continue;
    }

    const content = pdfStr.substring(lineStart, endObjIdx + 6);
    const typeIdx = content.indexOf('/Type /Page');
    if (typeIdx !== -1) {
      // Ensure it's "/Type /Page" and not "/Type /Pages".
      const charAfter = content[typeIdx + 11];
      if (charAfter === undefined || charAfter === '\n' || charAfter === '\r' || charAfter === '/' || charAfter === '>') {
        pageObjNum = parseInt(objNumStr, 10);
        pageObjContent = content;
        break;
      }
    }
    searchPos = endObjIdx + 6;
  }

  if (pageObjNum === -1)
    return buffer;

  // 3. Replace MediaBox in the Page object content.
  const mediaBoxIdx = pageObjContent.indexOf('/MediaBox');
  if (mediaBoxIdx === -1)
    return buffer;
  const bracketStart = pageObjContent.indexOf('[', mediaBoxIdx);
  const bracketEnd = pageObjContent.indexOf(']', bracketStart);
  if (bracketStart === -1 || bracketEnd === -1)
    return buffer;
  const newPageObj = pageObjContent.substring(0, bracketStart) +
    newMediaBox +
    pageObjContent.substring(bracketEnd + 1);

  // 4. Parse trailer to extract /Size, /Root, /Info.
  const trailerIdx = pdfStr.lastIndexOf('trailer');
  if (trailerIdx === -1)
    return buffer;
  const trailerDictStart = pdfStr.indexOf('<<', trailerIdx);
  const trailerDictEnd = pdfStr.indexOf('>>', trailerDictStart);
  if (trailerDictStart === -1 || trailerDictEnd === -1)
    return buffer;
  const trailerDict = pdfStr.substring(trailerDictStart + 2, trailerDictEnd);

  const sizeIdx = trailerDict.indexOf('/Size');
  if (sizeIdx === -1)
    return buffer;
  const sizeValueStart = sizeIdx + 6;
  let sizeValueEnd = sizeValueStart;
  while (sizeValueEnd < trailerDict.length && trailerDict[sizeValueEnd] >= '0' && trailerDict[sizeValueEnd] <= '9')
    sizeValueEnd++;
  const size = parseInt(trailerDict.substring(sizeValueStart, sizeValueEnd), 10);

  // Extract /Root and /Info references as-is (e.g. "/Root 7 0 R").
  const rootIdx = trailerDict.indexOf('/Root');
  const infoIdx = trailerDict.indexOf('/Info');
  let rootRef = '';
  let infoRef = '';
  if (rootIdx !== -1) {
    const refEnd = trailerDict.indexOf(' 0 R', rootIdx);
    if (refEnd !== -1)
      rootRef = trailerDict.substring(rootIdx, refEnd + 4).trim();
  }
  if (infoIdx !== -1) {
    const refEnd = trailerDict.indexOf(' 0 R', infoIdx);
    if (refEnd !== -1)
      infoRef = trailerDict.substring(infoIdx, refEnd + 4).trim();
  }

  if (!rootRef)
    return buffer;

  // 5. Build the incremental update appendix.
  const newObjOffset = buffer.length + 1; // +1 for the leading newline.
  let appendix = '\n';
  appendix += newPageObj + '\n';

  const newXrefOffset = buffer.length + appendix.length;
  appendix += 'xref\n';
  appendix += `${pageObjNum} 1\n`;
  appendix += `${String(newObjOffset).padStart(10, '0')} 00000 n \n`;

  appendix += 'trailer\n';
  appendix += `<</Size ${size} ${rootRef}`;
  if (infoRef)
    appendix += ` ${infoRef}`;
  appendix += ` /Prev ${prevXrefOffset}`;
  appendix += '>>\n';
  appendix += 'startxref\n';
  appendix += `${newXrefOffset}\n`;
  appendix += '%%EOF\n';

  return Buffer.from(pdfStr + appendix, 'binary');
}
