"""LLM 整篇排版:把转录段落拼接 → 加标点 → 分段 → 输出连续散文。"""
from __future__ import annotations

import re

from openai import OpenAI

from ..core.types import Segment

SYSTEM_PROMPT = """你是中文文章排版编辑。输入是一段语音转写后的文本(可能缺标点、断句不规整、有少量错字)。

任务:
1. 补全所有缺失的标点符号(逗号、句号、问号、感叹号、引号等)
2. 按语义和节奏分段(每段 3-6 句较合理)
3. 修正剩余的明显错别字 / 同音字
4. 不要增删原文意思,不要改写句子结构
5. 不要加入解释、注释、小标题
6. 直接输出排版后的纯文本,不要包裹任何说明

输出:整理后的纯文本文章,段与段之间用一个空行分隔。"""


class ArticlePolisher:
    name = "article_polisher"

    def __init__(
        self,
        api_key: str,
        base_url: str = "https://api.deepseek.com",
        model: str = "deepseek-v4-flash",
        temperature: float = 0.3,
        max_tokens: int = 384000,
        top_p: float = 1.0,
        frequency_penalty: float = 0.0,
        presence_penalty: float = 0.0,
    ):
        if not api_key:
            raise ValueError("api_key is required")
        self.client = OpenAI(api_key=api_key, base_url=base_url)
        self.base_url = base_url
        self.model = model
        self.temperature = temperature
        self.max_tokens = max_tokens
        self.top_p = top_p
        self.frequency_penalty = frequency_penalty
        self.presence_penalty = presence_penalty

    def polish(self, segments: list[Segment]) -> dict:
        """Returns dict: {text, finish_reason, truncated}."""
        raw = "".join(s.text for s in segments)
        raw = re.sub(r"\s+", "", raw)
        if not raw:
            return {"text": "", "finish_reason": "stop", "truncated": False}
        rsp = self.client.chat.completions.create(
            model=self.model,
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": raw},
            ],
            temperature=self.temperature,
            max_tokens=self.max_tokens,
            top_p=self.top_p,
            frequency_penalty=self.frequency_penalty,
            presence_penalty=self.presence_penalty,
        )
        choice = rsp.choices[0]
        finish_reason = choice.finish_reason or "stop"
        return {
            "text": (choice.message.content or "").strip(),
            "finish_reason": finish_reason,
            "truncated": finish_reason == "length",
            "input_chars": len(raw),
        }
