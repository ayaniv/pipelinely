import type { CreaturePlacement } from '../../../src/types'
import { useSnapshot } from './snapshot'

const DEFAULT_CREATURE_PLACEMENT: CreaturePlacement = 'header'

// The one place a call site asks "are creatures on?". Falls back to the
// header before the first snapshot lands, and for a server that predates the
// setting.
export function useCreaturePlacement(): CreaturePlacement {
  const { data } = useSnapshot()
  return data?.settings.creaturePlacement ?? DEFAULT_CREATURE_PLACEMENT
}
