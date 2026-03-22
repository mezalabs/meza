use std::time::Duration;

use anyhow::Result;
use crossterm::event::{EventStream, KeyEventKind};
use futures_util::StreamExt;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

/// Events produced by the event loop.
#[derive(Debug, Clone)]
pub enum Event {
    Key(crossterm::event::KeyEvent),
    Tick,
    Resize(u16, u16),
}

/// Spawns a background task that reads terminal events and tick intervals,
/// forwarding them through a bounded channel.
pub struct EventHandler {
    rx: mpsc::Receiver<Event>,
    cancel: CancellationToken,
}

impl EventHandler {
    /// Create a new `EventHandler`. Spawns the reader task immediately.
    pub fn new() -> Self {
        let cancel = CancellationToken::new();
        let (tx, rx) = mpsc::channel(256);

        let token = cancel.clone();
        tokio::spawn(async move {
            let mut reader = EventStream::new();
            let mut tick = tokio::time::interval(Duration::from_millis(60));

            loop {
                tokio::select! {
                    _ = token.cancelled() => break,

                    _ = tick.tick() => {
                        if tx.send(Event::Tick).await.is_err() {
                            break;
                        }
                    }

                    maybe_event = reader.next() => {
                        match maybe_event {
                            Some(Ok(crossterm::event::Event::Key(key))) => {
                                if key.kind == KeyEventKind::Press
                                    && tx.send(Event::Key(key)).await.is_err()
                                {
                                    break;
                                }
                            }
                            Some(Ok(crossterm::event::Event::Resize(w, h))) => {
                                if tx.send(Event::Resize(w, h)).await.is_err() {
                                    break;
                                }
                            }
                            Some(Ok(_)) => {} // ignore other events
                            Some(Err(_)) => break,
                            None => break,
                        }
                    }
                }
            }
        });

        Self { rx, cancel }
    }

    /// Wait for the next event.
    pub async fn next(&mut self) -> Result<Event> {
        self.rx
            .recv()
            .await
            .ok_or_else(|| anyhow::anyhow!("event channel closed"))
    }

    /// Signal the background task to stop.
    pub fn stop(&self) {
        self.cancel.cancel();
    }
}
