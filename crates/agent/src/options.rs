//! Validated per-task execution limits; callers cannot exceed the installed model's context.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SessionOptions {
    pub effort: String,
    pub context_tokens: u32,
    pub max_output_tokens: u32,
    /// Per-request llama.cpp thinking budget (0 means no reasoning, if supported by the model/template).
    pub reasoning_budget_tokens: u32,
    pub max_steps: usize,
    pub max_continuations: usize,
    pub temperature: f64,
    pub command_timeout_seconds: u64,
    pub auto_continue: bool,
    pub use_gpu: bool,
    pub search_endpoint: String,
    pub vision_endpoint: String,
    pub image_endpoint: String,
    /// The user's after-edit check (one command line), run when a turn changed files; empty = none.
    pub after_edit_command: String,
}

impl Default for SessionOptions {
    fn default() -> Self {
        Self {
            effort: "medium".into(),
            context_tokens: 0,
            max_output_tokens: 4_096,
            reasoning_budget_tokens: 1_024,
            max_steps: 128,
            max_continuations: 8,
            temperature: 0.6,
            command_timeout_seconds: 120,
            auto_continue: true,
            use_gpu: true,
            search_endpoint: String::new(),
            vision_endpoint: String::new(),
            image_endpoint: String::new(),
            after_edit_command: String::new(),
        }
    }
}

impl SessionOptions {
    pub fn bounded(mut self, model_context: u32) -> Self {
        if !matches!(self.effort.as_str(), "low" | "medium" | "high") {
            self.effort = "medium".into();
        }
        let ceiling = model_context.max(1_024);
        self.context_tokens = if self.context_tokens == 0 {
            ceiling
        } else {
            self.context_tokens.clamp(1_024, ceiling)
        };
        self.max_output_tokens = self
            .max_output_tokens
            .clamp(256, 32_768)
            .min(self.context_tokens / 2);
        // max_tokens includes reasoning as well as answer tokens. Preserve at
        // least 512 tokens for a visible answer and complete tool-call JSON.
        self.reasoning_budget_tokens = self
            .reasoning_budget_tokens
            .min(8_192)
            .min(self.max_output_tokens.saturating_sub(512));
        self.max_steps = self.max_steps.clamp(8, 512);
        self.after_edit_command = self.after_edit_command.trim().to_string();
        if self.after_edit_command.len() > 2_000
            || self.after_edit_command.chars().any(char::is_control)
        {
            self.after_edit_command.clear();
        }
        self.max_continuations = self.max_continuations.min(16);
        self.command_timeout_seconds = self.command_timeout_seconds.clamp(10, 600);
        self.temperature = if self.temperature.is_finite() {
            self.temperature.clamp(0.0, 1.0)
        } else {
            0.6
        };
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn automatic_defaults_to_real_engine_window_and_caps_output() {
        let small = SessionOptions::default().bounded(8_192);
        assert_eq!(small.context_tokens, 8_192);
        assert_eq!(small.max_output_tokens, 4_096);
        let larger = SessionOptions::default().bounded(32_768);
        assert_eq!(larger.context_tokens, 32_768);
        assert_eq!(larger.max_output_tokens, 4_096);
        assert_eq!(larger.reasoning_budget_tokens, 1_024);
    }

    #[test]
    fn manual_context_stays_within_the_actual_allocation() {
        let requested = SessionOptions {
            context_tokens: 32_768,
            ..Default::default()
        };
        assert_eq!(requested.bounded(16_384).context_tokens, 16_384);
        let requested = SessionOptions {
            context_tokens: 4_096,
            ..Default::default()
        };
        assert_eq!(requested.bounded(32_768).context_tokens, 4_096);
    }

    #[test]
    fn callers_cannot_overallocate_the_models_context_or_remove_limits() {
        let options = SessionOptions {
            context_tokens: 1_000_000,
            max_output_tokens: 1_000_000,
            max_steps: usize::MAX,
            temperature: f64::NAN,
            ..Default::default()
        }
        .bounded(32_768);
        assert_eq!(options.context_tokens, 32_768);
        assert_eq!(options.max_output_tokens, 16_384);
        assert_eq!(options.max_steps, 512);
        assert_eq!(options.temperature, 0.6);
    }

    #[test]
    fn reasoning_budget_is_independent_bounded_and_off_is_preserved() {
        let options = SessionOptions {
            reasoning_budget_tokens: 8_192,
            max_output_tokens: 1_024,
            ..Default::default()
        }
        .bounded(32_768);
        assert_eq!(options.reasoning_budget_tokens, 512);
        assert_eq!(options.max_output_tokens, 1_024);

        let off = SessionOptions {
            reasoning_budget_tokens: 0,
            max_output_tokens: 4_096,
            ..Default::default()
        }
        .bounded(32_768);
        assert_eq!(off.reasoning_budget_tokens, 0);

        let maximum = SessionOptions {
            reasoning_budget_tokens: u32::MAX,
            max_output_tokens: u32::MAX,
            ..Default::default()
        }
        .bounded(65_536);
        assert_eq!(maximum.reasoning_budget_tokens, 8_192);
        assert_eq!(maximum.max_output_tokens, 32_768);
    }

    #[test]
    fn legacy_options_without_reasoning_field_receive_safe_default() {
        let options: SessionOptions =
            serde_json::from_str(r#"{"contextTokens":0,"maxOutputTokens":16384,"effort":"high"}"#)
                .expect("legacy options deserialize");
        assert_eq!(options.reasoning_budget_tokens, 1_024);
        // Keep a user's pre-existing output preference rather than overwriting it.
        assert_eq!(options.bounded(32_768).max_output_tokens, 16_384);
    }
}
