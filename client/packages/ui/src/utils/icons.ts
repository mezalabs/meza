import type { Icon } from '@phosphor-icons/react';
import {
  ChatIcon,
  GameControllerIcon,
  GearIcon,
  GlobeIcon,
  HandshakeIcon,
  PaletteIcon,
  ShieldIcon,
  SpeakerHighIcon,
  SparkleIcon,
} from '@phosphor-icons/react';

const iconMap: Record<string, Icon> = {
  'gamepad-2': GameControllerIcon,
  handshake: HandshakeIcon,
  palette: PaletteIcon,
  globe: GlobeIcon,
  sparkles: SparkleIcon,
  'message-square': ChatIcon,
  'volume-2': SpeakerHighIcon,
  shield: ShieldIcon,
  settings: GearIcon,
};

export function resolveIcon(name: string): Icon | null {
  return iconMap[name] ?? null;
}
