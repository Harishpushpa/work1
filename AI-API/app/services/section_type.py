import re

# Heading la keyword irundha andha type; match aagala na "other" (general prompt mattum)
SECTION_KEYWORDS = {
    "pricing": r"premium|price|pricing|fee|charge|excess|deductible|discount|payment",
    "eligibility": r"eligib|who can|age limit|qualif|requirement",
    "process": r"claim|procedure|how to|process|step|notice|renew|cancel",
    "policy": r"exclusion|exception|condition|terms|liabilit|limit|warrant|general",
}

# Base prompt kooda sethu pogum extra guidance
TYPE_HINTS = {
    "pricing": "This section is about money. Ask about amounts, limits, charges, excess and payment rules, and keep every figure exactly as written.",
    "eligibility": "This section is about who can apply or be covered. Ask about conditions, age limits and documents required.",
    "process": "This section is about a procedure. Ask 'how do I...' questions and keep the steps and time limits in order.",
    "policy": "This section is about rules and exclusions. Write a separate question for each rule or exclusion and keep every condition.",
}


def get_section_type(title: str) -> str:
    for name, pattern in SECTION_KEYWORDS.items():
        if re.search(pattern, title or "", re.I):
            return name
    return "other"


def get_type_hint(section_type: str) -> str:
    hint = TYPE_HINTS.get(section_type)
    return f"\nSection guidance: {hint}\n" if hint else ""
