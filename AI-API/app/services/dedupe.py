import re

import numpy as np

from app.core import config
from app.core.config import DUPLICATE_THRESHOLD
from app.services.embeddings import embed

ANSWER_THRESHOLD = getattr(config, "ANSWER_DUPLICATE_THRESHOLD", 0.85)
CONFLICT_Q_THRESHOLD = 0.97 

CONDITION_RE = re.compile(
    r"\b(only if|unless|provided that|whichever|except|subject to)\b", re.I
)


def _quality(f):
    a = f["answer"].strip()
    return (
        not a.endswith((".", "!", "?")),  
        -len(CONDITION_RE.findall(a)),  
        -sum(c.isdigit() for c in a),  
        len(a),  
    )


def remove_duplicates(faqs):
    if len(faqs) < 2:
        return faqs

    qv = embed([f["question"] for f in faqs])
    av = embed([f["answer"] for f in faqs])

    order = sorted(range(len(faqs)), key=lambda i: _quality(faqs[i]))
    kept = []
    for i in order:
        if kept:
            q_sim = qv[kept] @ qv[i] 
            a_sim = av[kept] @ av[i]
            if np.any((q_sim > DUPLICATE_THRESHOLD) & (a_sim > ANSWER_THRESHOLD)):
                continue  
            for pos in np.where(
                (q_sim > CONFLICT_Q_THRESHOLD) & (a_sim <= ANSWER_THRESHOLD)
            )[0]:
                faqs[kept[pos]]["needs_review"] = True
                faqs[i]["needs_review"] = True
        kept.append(i)
    return [faqs[i] for i in sorted(kept)]
