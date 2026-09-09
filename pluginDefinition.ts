import type {
  ComplexPluginDefinition,
  PluginNetworkUiAdapterContract,
} from '@/features/plugins/complexPluginContracts';

/**
 * ScaleX LAN Manager network adapter.
 *
 * `materials`/`materialsEdit` are repurposed as the *printer* picker (see
 * `network/handlers/printers.ts` for the full rationale): ScaleX manages a
 * farm of printers behind one host:port, but this contract only gives a
 * complex plugin one per-job pick, and that's the one, so each entry
 * returned by `materials` is a ScaleX-managed printer, not an on-device
 * material profile.
 *
 * ScaleX has no API to edit those remotely, hence
 * `remoteMaterialEditingWipNotice` below and the primary/basic/advanced
 * edit-field arrays staying empty — `RemoteMaterialSettingsAdapter` still
 * requires the shape, but there is nothing to edit.
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
  supportsRemoteMaterialProfiles: true,
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
  },
  networkAdaptersByMode: {
    [SCALEX_NETWORK_ADAPTER.mode]: SCALEX_NETWORK_ADAPTER,
  },
};

export default SCALEX_LAN_MANAGER_PLUGIN_DEFINITION;
