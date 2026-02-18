# CramKit Knowledge Graph: Resource-Level vs Chunk-Level Relationships

## Executive Summary

The CramKit knowledge graph has a **critical architectural issue**: the base indexer (`graph-indexer.ts`) creates BOTH resource-level AND chunk-level relationships based on LLM extraction, but this logic applies **universally regardless of resource type**. For **lecture notes**, the LLM extraction output includes chunk titles in `file_concept_links`, causing relationships to be attached to chunks instead of resources. For **past papers**, chunks are primarily identified by question labels (Q1, Q2, etc.), so the chunk matching succeeds more reliably.

## Data Model

### Relationship Entity (Prisma)
```prisma
model Relationship {
  id        String  @id
  sessionId String
  
  sourceType  String  # "resource", "chunk", or "concept"
  sourceId    String
  sourceLabel String?
  
  targetType  String  # typically "concept"
  targetId    String
  targetLabel String?
  
  relationship String  # e.g., "covers", "introduces", "tests"
  confidence   Float   @default(1.0)
  createdBy    String  # "system", "claude", "amortised"
  createdFromResourceId String?
}
```

**Key insight**: The `sourceType` field determines whether a relationship is resource-level or chunk-level. Both are treated identically by the system.

## Code Paths for Relationship Creation

### 1. Base Indexer (graph-indexer.ts) - Creates BOTH Levels

**File**: `/Users/gong/Programming/Projects/cramkit/packages/api/src/services/graph-indexer.ts`

#### Function: `buildRelationshipData()` (lines 102-186)

This is the **core logic** that decides whether relationships are resource-level or chunk-level:

```typescript
function buildRelationshipData(
  result: ExtractionResult,
  conceptMap: Map<string, string>,
  chunkByTitle: Map<string, string>,
  chunks: ChunkInfo[],
  sessionId: string,
  resourceId: string,
  resourceName: string,
): RelData[] {
  const relationships: RelData[] = [];

  // === FILE-CONCEPT LINKS ===
  for (const link of result.file_concept_links) {
    const target = resolveConcept(link.conceptName, conceptMap);
    if (!target) continue;

    let sourceType = "resource";  // DEFAULT: resource-level
    let sourceId = resourceId;
    let sourceLabel = resourceName;

    if (link.chunkTitle) {  // IF chunk title provided, try to find chunk
      const chunkId = fuzzyMatchTitle(link.chunkTitle, chunkByTitle);
      if (chunkId) {
        sourceType = "chunk";  // OVERRIDE to chunk-level
        sourceId = chunkId;
        sourceLabel = link.chunkTitle;
      }
    }
    
    relationships.push(
      makeRel(sessionId, sourceType, sourceId, sourceLabel, ...)
    );
  }

  // === CONCEPT-CONCEPT LINKS ===
  for (const link of result.concept_concept_links) {
    // Always concept-to-concept, no resource/chunk level
    relationships.push(
      makeRel(sessionId, "concept", source.id, source.name, "concept", ...)
    );
  }

  // === QUESTION-CONCEPT LINKS ===
  for (const link of result.question_concept_links) {
    const target = resolveConcept(link.conceptName, conceptMap);
    const matchingChunk = findChunkByLabel(chunks, link.questionLabel);
    
    relationships.push(
      makeRel(
        sessionId,
        matchingChunk ? "chunk" : "resource",  // Chunk if found, else resource
        matchingChunk?.id || resourceId,
        link.questionLabel,
        ...
      ),
    );
  }

  return relationships;
}
```

**Key Decision Points**:
1. **file_concept_links**: Starts as `sourceType="resource"`, converts to `sourceType="chunk"` IF:
   - LLM extraction includes `chunkTitle` field
   - Fuzzy title matching finds the chunk (Dice coefficient > 0.6)

2. **concept_concept_links**: Always `sourceType="concept"`

3. **question_concept_links**: Chunk-level if question matches a chunk, else resource-level

### Why Lecture Notes Have Zero Resource-Level Rels

**LLM Extraction Output Example** (from tests):
```javascript
file_concept_links: [
  { conceptName: "Method Of Characteristics", relationship: "introduces", confidence: 0.95 },
  // NO chunkTitle field!
  { conceptName: "Heat Equation", relationship: "covers", confidence: 0.9 },
  // NO chunkTitle field!
]
```

Since lecture notes extraction **does NOT include `chunkTitle` in `file_concept_links`**, the fuzzy match is skipped and relationships **should remain at resource level**.

### Why Past Papers Likely Have Both Levels

```javascript
file_concept_links: [
  { conceptName: "Method Of Characteristics", relationship: "applies", confidence: 0.9 },
  // NO chunkTitle - creates RESOURCE-level rel
]
question_concept_links: [
  { questionLabel: "Q1(a)", conceptName: "Method Of Characteristics", relationship: "tests", confidence: 0.9 },
  // Matches chunk "Q1(a)" - creates CHUNK-level rel
]
```

Past papers have **both**:
- Resource-level: from `file_concept_links` (when no chunk title)
- Chunk-level: from `question_concept_links` (questions match chunks by label)

## 2. Metadata Indexer (metadata-indexer.ts) - Question-Level Only

**File**: `/Users/gong/Programming/Projects/cramkit/packages/api/src/services/metadata-indexer.ts` (lines 225-248)

Metadata indexer creates question→concept relationships with `sourceType="question"` (distinct from chunks):

```typescript
await tx.relationship.create({
  data: {
    sessionId: resource.sessionId,
    sourceType: "question",  // <-- QUESTION-specific type (not chunk!)
    sourceId: pq.id,         // <-- PaperQuestion ID, not Chunk ID
    sourceLabel: q.questionNumber,
    targetType: "concept",
    targetId: conceptId,
    ...
  },
});
```

## Query Path: get_related(resource, ...)

**File**: `/Users/gong/Programming/Projects/cramkit/packages/api/src/routes/graph.ts` (lines 70-87)

```typescript
graphRoutes.get("/related", async (c) => {
  const type = c.req.query("type");
  const id = c.req.query("id");
  
  const where: Record<string, unknown> = {
    OR: [
      { sourceType: type, sourceId: id },      // Source
      { targetType: type, targetId: id },      // Target
    ],
  };

  const relationships = await db.relationship.findMany({ where });
  return c.json(relationships);
});
```

**No aggregation**: This returns relationships where the entity appears as source OR target. It does NOT:
- Roll up chunk relationships to resource level
- Aggregate across chunks
- Handle resource vs chunk relationships differently

If you query `get_related(type="resource", id="X")`, you get **ONLY** relationships where `sourceType="resource"` AND `sourceId="X"` (or target).

## 3. Cross-Linker (cross-linker.ts) - Resource-Level Construction

**File**: `/Users/gong/Programming/Projects/cramkit/packages/api/src/services/cross-linker.ts` (lines 204-225)

```typescript
const resourceConcepts: Record<
  string,
  Array<{ name: string; relationship: string; confidence: number }>
> = {};

for (const rel of allRelationships) {
  if (rel.sourceType === "resource" && rel.targetType === "concept") {
    // Only captures RESOURCE-level rels
    if (!resourceConcepts[rel.sourceId]) resourceConcepts[rel.sourceId] = [];
    resourceConcepts[rel.sourceId].push({
      name: rel.targetLabel ?? "",
      relationship: rel.relationship,
      confidence: rel.confidence,
    });
  }
  if (rel.sourceType === "chunk" && rel.targetType === "concept") {
    // Incomplete handling of chunk-level rels
    for (const res of resources) {
      if (!resourceConcepts[res.id]) resourceConcepts[res.id] = [];
    }
  }
}
```

**Critical issue**: Cross-linker **explicitly filters** for `sourceType="resource"` only. Chunk-level relationships are partially handled but not fully aggregated.

## 4. Amortiser (amortiser.ts) - Chunk-Level ONLY

**File**: `/Users/gong/Programming/Projects/cramkit/packages/api/src/services/amortiser.ts` (lines 71-82)

```typescript
toCreate.push({
  sessionId,
  sourceType: "chunk",  // <-- ALWAYS chunk-level
  sourceId: result.chunkId,
  sourceLabel: chunkTitleMap.get(result.chunkId) ?? null,
  targetType: "concept",
  targetId: concept.id,
  ...
});
```

Amortiser creates **chunk-level relationships only**.

## 5. MCP Tools - No Aggregation

**File**: `/Users/gong/Programming/Projects/cramkit/packages/mcp/src/tools/graph.ts`

```typescript
get_related: {
  description:
    "Get all knowledge graph relationships for an entity. Returns relationships where the entity appears as source or target...",
  execute: async ({ type, id, relationshipType }) =>
    apiClient.getRelated(type, id, relationshipType),
}
```

MCP's `get_related` tool does **NOT** aggregate relationships. When Claude asks for related concepts for a resource, it gets only direct relationships, not chunk-rolled-up ones.

---

## Root Cause: Missing Chunk Title in Lecture Notes Extraction

**Expected LLM output** (what would create chunk-level rels):
```javascript
file_concept_links: [
  { 
    conceptName: "Method Of Characteristics", 
    relationship: "introduces",
    chunkTitle: "Solving First-Order PDEs",  // <-- Chunk title!
    confidence: 0.95 
  }
]
```

**Actual LLM output** (creates resource-level rels):
```javascript
file_concept_links: [
  { 
    conceptName: "Method Of Characteristics", 
    relationship: "introduces",
    // NO chunkTitle field
    confidence: 0.95 
  }
]
```

**Decision logic** in `buildRelationshipData()`:
- No `chunkTitle` → no fuzzy match → `sourceType` stays "resource"
- Creates resource-level relationship ✅

BUT if the test fixtures don't show resource-level rels being created, it means either:
1. The LLM extraction isn't being invoked correctly
2. The relationships are being deleted somewhere
3. The test is querying incorrectly

---

## Summary of Code Paths

| Source | Creates | Level | Condition |
|--------|---------|-------|-----------|
| `graph-indexer` (file_concept) | Resource OR Chunk | Chunk if `chunkTitle` AND fuzzy match, else Resource |
| `graph-indexer` (concept_concept) | Concept → Concept | Always Concept |
| `graph-indexer` (question_concept) | Chunk OR Resource | Chunk if label fuzzy matches, else Resource |
| `metadata-indexer` | Question → Concept | Always Question (distinct from Chunk) |
| `amortiser` | Chunk → Concept | Always Chunk |
| `cross-linker` | Concept → Concept | Always Concept |
| MCP `create_link` | Custom | Whatever user specifies |

---

## No Rollup Mechanism

**There is NO rollup from chunk-level to resource-level**. The system does not:
- Aggregate chunk relationships to resource level
- Answer "what concepts does this resource cover?" by combining chunk rels
- Support both perspectives simultaneously

`get_related(type="resource", id="X")` returns ONLY explicit resource-level rels, not chunk-rolled-up ones.

---

## Specific File Locations

1. **Relationship schema**: `/Users/gong/Programming/Projects/cramkit/prisma/schema.prisma` (lines 112-136)
2. **buildRelationshipData()**: `/Users/gong/Programming/Projects/cramkit/packages/api/src/services/graph-indexer.ts` (lines 102-186)
3. **clearOldRelationships()**: `/Users/gong/Programming/Projects/cramkit/packages/api/src/services/graph-indexer.ts` (lines 198-216)
4. **get_related endpoint**: `/Users/gong/Programming/Projects/cramkit/packages/api/src/routes/graph.ts` (lines 70-87)
5. **Cross-linker aggregation**: `/Users/gong/Programming/Projects/cramkit/packages/api/src/services/cross-linker.ts` (lines 204-225)
6. **Amortiser**: `/Users/gong/Programming/Projects/cramkit/packages/api/src/services/amortiser.ts` (lines 71-82, 174-187)
7. **MCP get_related**: `/Users/gong/Programming/Projects/cramkit/packages/mcp/src/tools/graph.ts` (lines 35-49)
8. **API client**: `/Users/gong/Programming/Projects/cramkit/packages/mcp/src/lib/api-client.ts` (lines 64-67)
