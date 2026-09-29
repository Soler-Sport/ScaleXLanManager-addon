import type {
  ComplexPluginDefinition,
  PluginNetworkUiAdapterContract,
} from '@/features/plugins/complexPluginContracts';

/**
 * ScaleX LAN Manager network adapter.
 *
 * ScaleX manages a farm of printers behind one host:port and adapts the
 * uploaded file to whichever printer receives it, so DragonFruit keeps its
 * standard local material menu (`supportsRemoteMaterialProfiles: false`) and
 * never loads per-printer profiles from the manager. The target farm printer
 * is chosen at send time in the Printing panel and travels through the
 * upload contract's `profileId` slot; `scalex/printers/list` (still wired to
 * `materials` below, as the contract requires) only feeds that picker.
 *
 * ScaleX has no API to edit printer settings remotely, hence the empty
 * primary/basic/advanced edit-field arrays — the adapter shape is still
 * required, but there is nothing to edit.
 */
const SCALEX_NETWORK_ADAPTER: PluginNetworkUiAdapterContract = {
  mode: 'scalex',
  pluginId: 'scalex-lan-manager',
  displayName: 'ScaleX LAN Manager',
  operationNamespace: 'scalex',
  operations: {
    connect: 'scalex/connect',
    discover: 'scalex/discover',
    materials: 'scalex/printers/list',
    materialsEdit: 'scalex/printers/edit',
  },
  defaultLocalHostnames: ['scalex.local', 'scalex-lan-manager.local', 'printfarm.local'],
  // ScaleX adapts the sliced file to whichever farm printer receives it, so
  // DragonFruit keeps its own standard (local) material menu and never loads
  // per-printer profiles from the manager. The target farm printer is chosen
  // at send time instead (see the printer picker in the Printing panel).
  supportsRemoteMaterialProfiles: false,
  remoteMaterialEditingWipNotice:
    "This list is the farm's printers, not on-device material profiles — ScaleX doesn't expose profile editing over its API, so Edit is unavailable here.",
  primaryEditFields: [],
  basicSections: [],
  advancedSections: [],
  resolveEditDraftFromMeta: () => ({}),
  resolveMaterialProcessValues: () => ({}),
  denormalizeEditDraftForBackend: (draft) => draft,
  resolveAdvancedSectionId: () => '',
  getFieldHelpText: () => '',
  isDynamicWaitEnabled: () => false,
};

export const SCALEX_LAN_MANAGER_PLUGIN_DEFINITION: ComplexPluginDefinition = {
  id: 'scalex-lan-manager',
  manifest: {
    id: 'scalex-lan-manager-builtin',
    name: 'ScaleX LAN Manager',
    version: '0.1.0',
    description: 'Send print jobs straight to a ScaleX LAN Manager print farm (SDCP, e.g. Elegoo Saturn 4 / EL3D-4) instead of exporting and uploading by hand.',
    author: 'Soler-Sport',
    homepage: 'https://github.com/Soler-Sport/ScaleXLanManager-addon',
  },
  capabilities: {
    networkOperations: true,
    uploadWithProgress: true,
    // The desktop app routes every plugin network call through Rust (there is
    // no HTTP fallback inside Tauri), so this plugin ships rust/plugin.rs +
    // rust/network.rs mirroring network/handlers/*.ts. See rust/network.rs.
    tauriRuntimePlugin: true,
  },
  networkAdaptersByMode: {
    [SCALEX_NETWORK_ADAPTER.mode]: SCALEX_NETWORK_ADAPTER,
  },
};

export default SCALEX_LAN_MANAGER_PLUGIN_DEFINITION;
