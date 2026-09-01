import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/lib/auth';
import { PrismaClient } from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';
import { put } from '@vercel/blob';
import { DocumentTextError, extractPdfText } from '@/lib/document-text';
import {
  exceedsUploadRequestLimit,
} from '@/lib/security';
import { MAX_FILE_SIZE, isAcceptedFile } from '@/lib/upload-policy';

const prisma = new PrismaClient();

export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions);

    if (!session || !session.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (exceedsUploadRequestLimit(req.headers)) {
      return NextResponse.json({ error: 'File size exceeds 50MB limit.' }, { status: 413 });
    }

    const formData = await req.formData();
    const file = formData.get('file');
    const courseIdValue = formData.get('courseId');
    const courseId = typeof courseIdValue === 'string' && courseIdValue.trim() ? courseIdValue.trim() : null;

    if (!(file instanceof File)) {
      return NextResponse.json({ error: 'No file uploaded' }, { status: 400 });
    }

    if (!isAcceptedFile({ name: file.name, type: file.type })) {
      return NextResponse.json({ error: 'Invalid file type. Only PDF and MD are allowed.' }, { status: 400 });
    }

    if (file.size > MAX_FILE_SIZE) {
      return NextResponse.json({ error: 'File size exceeds 50MB limit.' }, { status: 413 });
    }

    if (courseId) {
      const course = await prisma.course.findFirst({
        where: { id: courseId, userId: (session.user as { id: string }).id },
        select: { id: true },
      });
      if (!course) return NextResponse.json({ error: 'Invalid course selected.' }, { status: 400 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const isMd = file.name.toLowerCase().endsWith('.md') || file.name.toLowerCase().endsWith('.markdown');

    let extractedText: string;

    if (!isMd) {
      // Security: Check Magic Bytes to ensure it is actually a PDF file (%PDF)
      if (buffer.length < 4 || buffer[0] !== 0x25 || buffer[1] !== 0x50 || buffer[2] !== 0x44 || buffer[3] !== 0x46) {
        return NextResponse.json({ error: 'Security alert: Invalid file signature. Fake PDF detected.' }, { status: 400 });
      }

      try {
        extractedText = await extractPdfText(buffer);
      } catch (error) {
        if (error instanceof DocumentTextError) {
          return NextResponse.json({ error: error.message }, { status: error.status });
        }
        console.error('PDF extraction failed:', error);
        return NextResponse.json({ error: 'ไม่สามารถอ่านข้อความจาก PDF ได้' }, { status: 422 });
      }
    } else {
      extractedText = buffer.toString('utf8');
    }

    const fileName = `${uuidv4()}${isMd ? '.md' : '.pdf'}`;

    // Upload file to Vercel Blob
    const [fileBlob, textBlob] = await Promise.all([
      put(fileName, buffer, {
        access: 'private',
        contentType: isMd ? 'text/markdown' : 'application/pdf',
      }),
      put(`${fileName}.txt`, extractedText, {
        access: 'private',
        contentType: 'text/plain; charset=utf-8',
      }),
    ]);

    try {
      await prisma.document.create({
        data: {
          title: file.name,
          filename: fileName,
          url: `/api/files/${fileName}`,
          blobUrl: fileBlob.url,
          textBlobUrl: textBlob.url,
          size: file.size,
          mimeType: file.type,
          userId: (session.user as { id: string }).id,
          courseId,
        }
      });
    } catch (error) {
      console.error('Failed to save document:', error);
      return NextResponse.json({ error: 'ไม่สามารถบันทึกข้อมูลเอกสารได้' }, { status: 500 });
    }

    return NextResponse.json({
      message: 'File uploaded and text extracted successfully',
      filename: fileName,
      textLength: extractedText.length,
    }, { status: 201 });

  } catch (error) {
    console.error('Upload error:', error);
    if (exceedsUploadRequestLimit(req.headers)) {
      return NextResponse.json({ error: 'File size exceeds 50MB limit.' }, { status: 413 });
    }
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
