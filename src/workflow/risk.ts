import type { FileDiff } from '../diff.js'
import type { Guidance } from '../guidance.js'
import type { Finding } from '../review/index.js'
import { assessRisk, classifyRisk, maxTier, type RiskAssessment, type RiskClassifier } from '../risk/index.js'
import type { SecurityFinding } from '../security/index.js'
import type { ReviewState } from './markers.js'
import type { PullRequest } from './workflow.js'

/** What a round contributes to the tier. */
export type RiskRound = {
  /** Full PR diff (not filtered by skip_paths). */
  readonly prFiles: readonly FileDiff[]
  /** Base-ref guidance (REVIEW.md globs). */
  readonly guidance: Guidance | undefined
  /** Bug findings posted this round. */
  readonly bugs: readonly Finding[]
  /** Security findings posted this round. */
  readonly security: readonly SecurityFinding[]
  /** Automated review didn't run on these commits. */
  readonly skipped: boolean
}

/** The stored tier, or `next` when it is at least as risky (tiers never go down within a PR). */
export function stickyTier(state: ReviewState | undefined, next: RiskAssessment): RiskAssessment {
  const stored = state?.tier
  return stored !== undefined && maxTier(stored, next.tier) !== next.tier ? { tier: stored, reasons: state?.tierReasons ?? [] } : next
}

/** State fields for a tier. */
export const tierFields = (r: RiskAssessment | undefined) => (r ? { tier: r.tier, tierReasons: r.reasons } : {})

/** Rule floor for this round, raised by the classifier when one is given, then made sticky. */
export async function assessRound(pr: PullRequest, state: ReviewState | undefined, round: RiskRound, classifier?: RiskClassifier, log?: (line: string) => void): Promise<RiskAssessment> {
  const config = round.guidance?.review?.config
  const floor = assessRisk({
    files: round.prFiles,
    highPaths: config?.riskHighPaths ?? [],
    mediumPaths: config?.riskMediumPaths ?? [],
    skipPaths: config?.skipPaths ?? [],
    ...(config?.riskDefault !== undefined && { defaultTier: config.riskDefault }),
    ...(config?.riskLargePrLines !== undefined && { largeLines: config.riskLargePrLines }),
    blockingSecurity: round.security.some((f) => f.introduced && f.severity !== 'low'),
    skipped: round.skipped,
  })
  const intent = `${pr.title}\n\n${pr.body}`.trim()
  const diff = round.prFiles.map((f) => f.text).join('')
  const assessed = classifier ? await classifyRisk(classifier, { diff, intent, floor }) : floor
  const final = stickyTier(state, assessed)
  log?.(`Risk: rules say ${floor.tier}${classifier ? `, after classifier ${assessed.tier}` : ''}${final.tier !== assessed.tier ? `, kept ${final.tier} from an earlier round` : ''} → ${final.tier} (${final.reasons.join('; ')})`)
  return final
}
