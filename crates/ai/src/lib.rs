//! OpenMind Studio's AI provider layer (Milestone 13). Providers are data ([`ProviderConfig`]); one client speaks
//! the Claude, OpenAI-compatible (also a custom endpoint and a local server) and Gemini wire formats.
//!
//! Rules this crate keeps: nothing runs until the app calls it for a user action (no background request, no
//! telemetry); an API key is passed in for a single call and is never stored, logged or put in an error;
//! endpoints are https (http only for this computer); redirects are never followed; conversations stay in a
//! local SQLite file. It is Tauri-agnostic — the app supplies key storage and events.

pub mod client;
pub mod error;
pub mod provider;
pub mod registry;
pub mod store;
pub mod transport;
pub mod wire;

pub use client::{chat, embed_text, list_embedding_models, list_models};
pub use error::{redact, AiError};
pub use provider::{Capability, ProviderConfig, ProviderKind};
pub use registry::ProviderStore;
pub use store::{Conversation, ConversationStore, ConversationSummary, StoredMessage};
pub use wire::{ChatMessage, ChatRequest, ModelInfo};
