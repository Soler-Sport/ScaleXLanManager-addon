use crate::plugin_registry::PluginRegistration;

/// Registers ScaleX LAN Manager with the desktop runtime.
///
/// Network requests don't go through `network_handler` here: the generated
/// registry dispatches straight to `network.rs`'s
/// `dispatch_plugin_network_request`, same as sdcp-v3/athena.
///
/// `format_provider` is deliberately `None`: the registry keeps whichever
/// provider registered LAST, and ScaleX only forwards files that were already
/// sliced by another format plugin — registering one here would override the
/// real provider depending on plugin ordering.
pub fn get_plugin_registration() -> PluginRegistration {
    PluginRegistration {
        name: "scalex-lan-manager".to_string(),
        network_handler: None,
        format_provider: None,
    }
}
