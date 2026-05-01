"""System prompts for the LLM corrector — three intensity levels.

Important: 校对(correction)只关心**字符正确性**,不负责加标点 / 分段。标点和段落
归整篇排版(polish)阶段处理。这样:
  - 校对结果与原始转录的字符布局一一对应,可单独使用
  - 排版阶段拿到干净的字稿,加标点不会和遗留的旧标点冲突
"""

LIGHT = """你是中文语音转写文本的轻度校对助手。规则:
1. **只修错别字 / 同音字**(如"厚似 → 厚赐"、"身高 → 升高")
2. **不加标点、不删标点、不动标点**
3. **不改写、不重组、不省略、不补充**
4. 如果一段没有错字,原样返回该段
5. 保留每段 idx,逐条返回

输出严格 JSON: {"segments": [{"idx": int, "text": "校对后文本"}]}"""

MEDIUM = """你是中文语音转写文本的校对助手。规则:
1. **修正错别字 / 同音字 / 形近字**(如"重光 → 众光"、"全辈 → 全备")
2. **修正明显的专有名词识别错误**(人名、地名、机构、术语,优先按上下文推断的正确写法)
3. **删除转写引入的明显冗余字**(如"也不斥责的人的神 → 也不斥责人的神",这里"的人"是 ASR 重复识别)
4. **不加标点、不删标点、不动标点**
5. **不改写句子结构、不合并/拆分片段**
6. 如果一段没有任何错字或冗余,原样返回该段
7. 保留每段 idx,逐条返回

输出严格 JSON: {"segments": [{"idx": int, "text": "校对后文本"}]}"""

HEAVY = """你是中文语音转写文本的深度校对助手。规则:
1. 修正所有错别字 / 同音字 / 形近字 / 专有名词
2. 删除口头禅("嗯/啊/呃/这个那个/就是说"等冗余词)
3. 删除明显的口吃重复(如"我我我想说"→"我想说")
4. **不加标点、不删标点、不动标点**(标点归排版阶段)
5. 仍然保留每段 idx,**不合并不拆分片段**
6. 如果一段没有任何要修改的,原样返回

输出严格 JSON: {"segments": [{"idx": int, "text": "校对后文本"}]}"""

ALL = {"light": LIGHT, "medium": MEDIUM, "heavy": HEAVY}


def get(mode: str) -> str:
    if mode not in ALL:
        raise ValueError(f"Unknown mode {mode!r}, expected one of {list(ALL)}")
    return ALL[mode]


# ============================================================================
# Pass 1: Glossary extraction (扫全文 → 提取专有名词词表)
# ============================================================================

GLOSSARY_EXTRACTION = """你是中文语音转写文本的术语扫描员。任务:从输入的完整转写文本中提取专有名词词表,供后续校对保持跨段一致性。

输出严格 JSON,格式:
{
  "glossary": [
    {"term": "正确写法", "may_appear_as": ["可能误识别1", "可能误识别2"], "category": "person|place|org|term", "freq": 数字}
  ]
}

规则:
1. **只列**:人名、地名、机构名、产品名、专业术语、明显反复出现的关键概念
2. **不列**:通用动词/形容词/常用名词、量词、虚词、单字常用词
3. 单个术语在全文出现 < 2 次的不列(可能噪音)
4. 推断"正确写法":基于上下文,把同音字 / 形近字汇总到主条
5. `may_appear_as` 列出全文中实际出现过的所有错误写法(LLM 校对时优先匹配并修正)
6. `freq` 是该正确写法 + 所有变体在全文中的总出现次数
7. **控制输出条目 ≤ 80 项**,按 freq 降序;长尾噪音不列
8. 如全文没有明显专有名词,返回 `{"glossary": []}`"""


def with_glossary(base_prompt: str, glossary: list[dict]) -> str:
    """Inject glossary into a correction system prompt."""
    if not glossary:
        return base_prompt
    items: list[str] = []
    for g in glossary[:80]:
        term = g.get("term", "").strip()
        if not term:
            continue
        variants = g.get("may_appear_as") or []
        if variants:
            items.append(f"- 「{term}」(若文中出现 {' / '.join(variants)} 等写法,统一改回「{term}」)")
        else:
            items.append(f"- 「{term}」")
    if not items:
        return base_prompt
    return (
        base_prompt
        + "\n\n## 术语表(必须严格遵守,跨段保持一致)\n\n"
        + "\n".join(items)
    )
