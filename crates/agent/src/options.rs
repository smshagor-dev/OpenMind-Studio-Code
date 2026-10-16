//! Validated per-task execution limits; callers cannot exceed the installed model's context.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SessionOptions {
    pub effort: String,
    pub context_tokens: u32,
    pub max_output_tokens: u32,
    pub max_steps: usize,
    pub max_continuations: usize,
    pub temperature: f64,
    pub command_timeout_seconds: u64,
    pub auto_continue: bool,
    pub use_gpu: bool,
    pub search_endpoint: String,
    pub vision_endpoint: String,
    pub image_endpoint: String,
}

impl Default for SessionOptions {
    fn default() -> Self {
        Self {
            effort: "medium".into(),
            context_tokens: 0,
            max_output_tokens: 16_384,
            max_steps: 128,
            max_continuations: 8,
            temperature: 0.6,
            command_timeout_seconds: 120,
            auto_continue: true,
            use_gpu: true,
            search_endpoint: String::new(),
            vision_endpoint: String::new(),
            image_endpoint: String::new(),
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
        self.max_steps = self.max_steps.clamp(8, 512);
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
}
