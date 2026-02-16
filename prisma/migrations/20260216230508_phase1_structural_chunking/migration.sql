-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "module" TEXT,
    "examDate" DATETIME,
    "scope" TEXT,
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "File" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "label" TEXT,
    "rawPath" TEXT NOT NULL,
    "processedPath" TEXT,
    "indexPath" TEXT,
    "pageCount" INTEGER,
    "fileSize" INTEGER,
    "splitMode" TEXT NOT NULL DEFAULT 'auto',
    "isIndexed" BOOLEAN NOT NULL DEFAULT false,
    "isGraphIndexed" BOOLEAN NOT NULL DEFAULT false,
    "graphIndexDurationMs" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "File_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Chunk" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "fileId" TEXT NOT NULL,
    "parentId" TEXT,
    "index" INTEGER NOT NULL,
    "depth" INTEGER NOT NULL DEFAULT 0,
    "nodeType" TEXT NOT NULL DEFAULT 'section',
    "slug" TEXT,
    "diskPath" TEXT,
    "title" TEXT,
    "content" TEXT NOT NULL,
    "startPage" INTEGER,
    "endPage" INTEGER,
    "keywords" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Chunk_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "File" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Chunk_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Chunk" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Relationship" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "sourceLabel" TEXT,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "targetLabel" TEXT,
    "relationship" TEXT NOT NULL,
    "confidence" REAL NOT NULL DEFAULT 1.0,
    "createdBy" TEXT NOT NULL DEFAULT 'system',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Relationship_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Concept" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "aliases" TEXT,
    "createdBy" TEXT NOT NULL DEFAULT 'system',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Concept_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "Chunk_fileId_idx" ON "Chunk"("fileId");

-- CreateIndex
CREATE INDEX "Chunk_parentId_idx" ON "Chunk"("parentId");

-- CreateIndex
CREATE INDEX "Relationship_sessionId_idx" ON "Relationship"("sessionId");

-- CreateIndex
CREATE INDEX "Relationship_sourceType_sourceId_idx" ON "Relationship"("sourceType", "sourceId");

-- CreateIndex
CREATE INDEX "Relationship_targetType_targetId_idx" ON "Relationship"("targetType", "targetId");

-- CreateIndex
CREATE INDEX "Concept_sessionId_idx" ON "Concept"("sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "Concept_sessionId_name_key" ON "Concept"("sessionId", "name");
