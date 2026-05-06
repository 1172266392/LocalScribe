"""Article translator using OpenAI-compatible LLM API.

Translates polished articles to target languages while maintaining:
- Paragraph structure
- Terminology consistency (via glossary from correction phase)
- Natural expression in target language
"""
from __future__ import annotations

import json

from openai import OpenAI

from . import prompts


class ArticleTranslator:
    """Translate articles using LLM with glossary support."""

    name = "article_translator"

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

    def translate(
        self,
        text: str,
        source_language: str | None,
        target_language: str,
        glossary: list[dict] | None = None,
    ) -> dict:
        """Translate article text to target language.

        Args:
            text: Article text to translate
            source_language: Source language code (for reference, optional)
            target_language: Target language code ("zh", "en", "ja", "ko")
            glossary: Optional glossary from correction phase

        Returns:
            dict with keys:
                - text: translated text
                - source_language: source language
                - target_language: target language
                - model: model used
                - char_count: character count of translated text
                - finish_reason: completion finish reason
                - truncated: whether output was truncated
                - input_chars: input character count
        """
        # Get base prompt for target language
        system_prompt = prompts.get_translation_prompt(target_language)

        # Inject glossary if available
        if glossary:
            system_prompt = prompts.with_glossary(system_prompt, glossary, target_language)

        # Prepare user message
        user_message = text

        # Call LLM
        try:
            response = self.client.chat.completions.create(
                model=self.model,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_message},
                ],
                temperature=self.temperature,
                max_tokens=self.max_tokens,
                top_p=self.top_p,
                frequency_penalty=self.frequency_penalty,
                presence_penalty=self.presence_penalty,
            )

            translated_text = response.choices[0].message.content or ""
            finish_reason = response.choices[0].finish_reason
            truncated = finish_reason == "length"

            return {
                "text": translated_text,
                "source_language": source_language,
                "target_language": target_language,
                "model": self.model,
                "char_count": len(translated_text),
                "finish_reason": finish_reason,
                "truncated": truncated,
                "input_chars": len(text),
            }

        except Exception as e:
            raise RuntimeError(f"Translation failed: {e}") from e
