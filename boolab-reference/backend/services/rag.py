"""Retrieve + rerank + format RAG context for system prompt."""

from __future__ import annotations

import logging
import uuid
from typing import Any

from db import get_pool
from services.embeddings import embed_text

logger = logging.getLogger(__name__)

TOP_K_RETRIEVE = 40
TOP_AFTER_RERANK = 10

_RANKER: Any = None


def _ranker():
    global _RANKER
    if _RANKER is None:
        from flashrank import Ranker

        _RANKER = Ranker(model_name="ms-marco-MiniLM-L-12-v2", max_length=256)
    return _RANKER


def _reranked_passage_text(p: dict[str, Any]) -> str:
    t = p.get("text")
    return str(t) if t is not None else ""


async def retrieve_context(query: str, daw_id: str, source_ids: list[str]) -> str:
    if not query.strip() or not source_ids:
        return ""

    try:
        q_emb = await embed_text(query)
    except Exception as e:
        logger.warning("RAG query embed failed: %s", e)
        return ""

    try:
        pool = await get_pool()
        uuid_ids = [uuid.UUID(s) for s in source_ids]
        limit = min(TOP_K_RETRIEVE, max(1, TOP_K_RETRIEVE))
        async with pool.acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT sc.text, s.name AS source_name, sc.embedding <=> $1::vector AS distance
                FROM source_chunks sc
                JOIN sources s ON sc.source_id = s.id
                WHERE sc.source_id = ANY($2::uuid[])
                  AND sc.embedding IS NOT NULL
                ORDER BY sc.embedding <=> $1::vector
                LIMIT $3
                """,
                q_emb,
                uuid_ids,
                limit,
            )
    except Exception as e:
        logger.warning("RAG pgvector query failed: %s", e)
        return ""

    if not rows:
        return ""

    passages: list[dict[str, Any]] = []
    for i, row in enumerate(rows):
        name = row["source_name"] or "source"
        doc = row["text"]
        label = f"[SOURCE: {name}]\n{doc}"
        passages.append({"id": str(i), "text": label})

    try:
        from flashrank import RerankRequest

        reranked = _ranker().rerank(RerankRequest(query=query, passages=passages))
        top = [_reranked_passage_text(p) for p in reranked[:TOP_AFTER_RERANK]]
    except Exception as e:
        logger.debug("RAG rerank skipped: %s", e)
        top = [_reranked_passage_text(p) for p in passages[:TOP_AFTER_RERANK]]

    top = [t for t in top if t and str(t).strip()]
    if not top:
        return ""

    block = (
        "### Context from sources:\n"
        "Answer using ONLY the provided source material below. Do not use outside knowledge. Always cite the source label when referencing content. If the answer is not in the sources, say so.\n\n"
        + "\n\n".join(top)
    )
    logger.info("RAG context injected chunks=%d chars=%d", len(top), len(block))
    return block
