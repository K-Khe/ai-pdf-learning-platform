import { PrismaClient } from '@prisma/client';
import { isSafeStoredDocumentFilename } from '@/lib/security';
import { execFile } from 'child_process';
import util from 'util';
import path from 'path';
import os from 'os';
import { v4 as uuidv4 } from 'uuid';
import pdfParse from 'pdf-parse';
import { writeFile, unlink } from 'fs/promises';
import { put } from '@vercel/blob';

const execFileAsync = util.promisify(execFile);

export class DocumentTextError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'DocumentTextError';
  }
}

function normalizeExtractedText(text: string) {
  return text
    .replace(/\u0000/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function extractPdfText(buffer: Buffer) {
  const tempId = uuidv4();
  const tempPath = path.join(os.tmpdir(), `${tempId}.pdf`);

  try {
    await writeFile(tempPath, buffer);
    // MarkItDown preserves headings and tables well when Python is installed.
    try {
      const { stdout } = await execFileAsync('python', ['-m', 'markitdown', tempPath], {
        maxBuffer: 1024 * 1024 * 50,
        windowsHide: true,
      });
      const text = normalizeExtractedText(stdout);
      if (text) return text;
    } catch (error) {
      // Python/MarkItDown is optional. Fall back to the bundled Node parser so
      // uploading ordinary text PDFs works on machines without Python.
      console.warn('MarkItDown unavailable; falling back to the Node PDF parser.', {
        code: (error as NodeJS.ErrnoException).code,
      });
    }

    const parsed = await pdfParse(buffer);
    const text = normalizeExtractedText(parsed.text);
    if (!text) {
      throw new DocumentTextError(
        'ไม่พบข้อความใน PDF ไฟล์นี้อาจเป็นเอกสารสแกนที่ต้องใช้ OCR',
        422,
      );
    }
    return text;
  } catch (error) {
    if (error instanceof DocumentTextError) throw error;
    console.error('PDF text extraction failed:', error);
    throw new DocumentTextError('ไม่สามารถอ่านข้อความจาก PDF ได้ โปรดลองไฟล์ PDF อื่น หรือใช้ไฟล์ที่มีข้อความเลือกได้', 422);
  } finally {
    try {
      await unlink(tempPath);
    } catch (e) {
      // Ignore cleanup errors
    }
  }
}

export async function getOwnedDocumentText(
  prisma: PrismaClient,
  userId: string,
  filename: string,
) {
  if (!isSafeStoredDocumentFilename(filename)) {
    throw new DocumentTextError('ชื่อไฟล์เอกสารไม่ถูกต้อง', 400);
  }

  const document = await prisma.document.findFirst({
    where: { filename, userId },
  });

  if (!document) {
    throw new DocumentTextError('ไม่พบเอกสารหรือคุณไม่มีสิทธิ์เข้าถึงไฟล์นี้', 404);
  }

  // Build auth headers for private blob access
  const blobAuthHeaders: HeadersInit = process.env.BLOB_READ_WRITE_TOKEN
    ? { Authorization: `Bearer ${process.env.BLOB_READ_WRITE_TOKEN}` }
    : {};

  // Try to fetch text from Blob (textBlobUrl)
  if (document.textBlobUrl) {
    try {
      const res = await fetch(document.textBlobUrl, { headers: blobAuthHeaders });
      if (res.ok) {
        const text = normalizeExtractedText(await res.text());
        if (text) return { document, text };
      }
    } catch (e) {
      console.warn('Failed to fetch text blob, will re-extract:', e);
    }
  }

  // Fallback: fetch PDF from Blob and re-extract text
  if (document.blobUrl) {
    try {
      const res = await fetch(document.blobUrl, { headers: blobAuthHeaders });
      if (!res.ok) throw new DocumentTextError('ไม่พบไฟล์ PDF บนเซิร์ฟเวอร์', 404);
      const buffer = Buffer.from(await res.arrayBuffer());
      const text = await extractPdfText(buffer);

      // Cache the extracted text back to Blob
      try {
        const textBlob = await put(`${filename}.txt`, text, {
          access: 'private',
          contentType: 'text/plain; charset=utf-8',
        });
        await prisma.document.update({
          where: { id: document.id },
          data: { textBlobUrl: textBlob.url },
        });
      } catch (cacheErr) {
        console.warn('Failed to cache extracted text to blob:', cacheErr);
      }

      return { document, text };
    } catch (error) {
      if (error instanceof DocumentTextError) throw error;
      throw new DocumentTextError('ไม่สามารถอ่านข้อความจาก PDF ได้', 422);
    }
  }

  throw new DocumentTextError('ไม่พบไฟล์ PDF บนเซิร์ฟเวอร์', 404);
}
