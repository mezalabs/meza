/// Actions that can be dispatched in the Elm-style update loop.
#[derive(Debug, Clone)]
pub enum Action {
    Quit,
    SwitchChannel(String),
    SwitchServer(String),
    SendMessage(String),
    ScrollUp,
    ScrollDown,
    ScrollHalfUp,
    ScrollHalfDown,
    ScrollTop,
    ScrollBottom,
    FocusInput,
    UnfocusInput,
    Login {
        email: String,
        password: String,
    },
    Tick,
    Render,
    Resize(u16, u16),
    NetworkEvent(Vec<u8>),
    Error(String),
    None,
}
