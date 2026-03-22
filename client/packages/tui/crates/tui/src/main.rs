use anyhow::Result;

mod app;
mod action;
mod event;
mod terminal;
mod config;
mod components;

#[tokio::main]
async fn main() -> Result<()> {
    println!("meza-tui scaffold - press q to quit");
    Ok(())
}
