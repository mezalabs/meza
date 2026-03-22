//! Channel key cache (in-memory).
//!
//! Manages versioned AES-256-GCM symmetric keys per channel.
//! For MVP, keys are cached in memory only and re-fetched from server on restart.

use std::collections::HashMap;
use zeroize::Zeroizing;

/// Maximum number of key versions to retain per channel.
const MAX_VERSIONS_PER_CHANNEL: usize = 3;

/// In-memory channel key cache.
///
/// Keys are indexed by `(channel_id, key_version)`.
pub struct ChannelKeyCache {
    /// Map of (channel_id, version) -> channel_key
    keys: HashMap<(String, u32), Zeroizing<[u8; 32]>>,
    /// Track latest version per channel for quick lookup
    latest: HashMap<String, u32>,
}

impl ChannelKeyCache {
    pub fn new() -> Self {
        Self {
            keys: HashMap::new(),
            latest: HashMap::new(),
        }
    }

    /// Get a channel key by channel ID and version.
    pub fn get(&self, channel_id: &str, version: u32) -> Option<&[u8; 32]> {
        self.keys
            .get(&(channel_id.to_string(), version))
            .map(|k| &**k)
    }

    /// Get the latest key version for a channel.
    pub fn latest_version(&self, channel_id: &str) -> Option<u32> {
        self.latest.get(channel_id).copied()
    }

    /// Get the latest channel key.
    pub fn get_latest(&self, channel_id: &str) -> Option<(u32, &[u8; 32])> {
        let version = self.latest_version(channel_id)?;
        self.get(channel_id, version).map(|k| (version, k))
    }

    /// Store a channel key, pruning old versions if needed.
    pub fn store(&mut self, channel_id: &str, version: u32, key: [u8; 32]) {
        let id = channel_id.to_string();

        // Update latest version
        let current_latest = self.latest.get(&id).copied().unwrap_or(0);
        if version > current_latest {
            self.latest.insert(id.clone(), version);
        }

        // Store the key
        self.keys.insert((id.clone(), version), Zeroizing::new(key));

        // Prune old versions (keep only MAX_VERSIONS_PER_CHANNEL)
        self.prune_channel(&id);
    }

    /// Remove all keys and clear the cache.
    pub fn clear(&mut self) {
        // Zeroizing will zero on drop
        self.keys.clear();
        self.latest.clear();
    }

    /// Remove all keys for a specific channel.
    pub fn remove_channel(&mut self, channel_id: &str) {
        self.keys.retain(|(cid, _), _| cid != channel_id);
        self.latest.remove(channel_id);
    }

    /// Get all channels that have cached keys.
    pub fn channels(&self) -> Vec<&str> {
        self.latest.keys().map(|s| s.as_str()).collect()
    }

    /// Prune old versions of a channel's keys, keeping only the newest MAX_VERSIONS_PER_CHANNEL.
    fn prune_channel(&mut self, channel_id: &str) {
        // Collect all versions for this channel
        let mut versions: Vec<u32> = self
            .keys
            .keys()
            .filter(|(cid, _)| cid == channel_id)
            .map(|(_, v)| *v)
            .collect();

        if versions.len() <= MAX_VERSIONS_PER_CHANNEL {
            return;
        }

        // Sort descending, keep the newest
        versions.sort_unstable_by(|a, b| b.cmp(a));
        let to_remove: Vec<u32> = versions[MAX_VERSIONS_PER_CHANNEL..].to_vec();

        for version in to_remove {
            self.keys.remove(&(channel_id.to_string(), version));
        }
    }
}

impl Default for ChannelKeyCache {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn store_and_retrieve() {
        let mut cache = ChannelKeyCache::new();
        let key: [u8; 32] = rand::random();
        cache.store("channel-1", 1, key);

        assert_eq!(cache.get("channel-1", 1), Some(&key));
        assert_eq!(cache.latest_version("channel-1"), Some(1));
    }

    #[test]
    fn get_latest() {
        let mut cache = ChannelKeyCache::new();
        let key1: [u8; 32] = rand::random();
        let key2: [u8; 32] = rand::random();
        cache.store("ch", 1, key1);
        cache.store("ch", 2, key2);

        let (version, key) = cache.get_latest("ch").unwrap();
        assert_eq!(version, 2);
        assert_eq!(key, &key2);
    }

    #[test]
    fn prunes_old_versions() {
        let mut cache = ChannelKeyCache::new();
        for v in 1..=5 {
            cache.store("ch", v, rand::random());
        }

        // Should keep only versions 3, 4, 5
        assert!(cache.get("ch", 1).is_none());
        assert!(cache.get("ch", 2).is_none());
        assert!(cache.get("ch", 3).is_some());
        assert!(cache.get("ch", 4).is_some());
        assert!(cache.get("ch", 5).is_some());
    }

    #[test]
    fn clear_removes_all() {
        let mut cache = ChannelKeyCache::new();
        cache.store("ch1", 1, rand::random());
        cache.store("ch2", 1, rand::random());
        cache.clear();

        assert!(cache.get("ch1", 1).is_none());
        assert!(cache.get("ch2", 1).is_none());
        assert!(cache.channels().is_empty());
    }

    #[test]
    fn missing_channel_returns_none() {
        let cache = ChannelKeyCache::new();
        assert!(cache.get("nonexistent", 1).is_none());
        assert!(cache.latest_version("nonexistent").is_none());
        assert!(cache.get_latest("nonexistent").is_none());
    }
}
