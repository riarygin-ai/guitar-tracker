// Tiny deterministic dictionary for the STANDARD chrome of the two AI Advice
// surfaces (General Business Coach + Listing Advice): card/drawer labels,
// badges, buttons, empty states. NOT an application i18n framework, and never
// AI-translated. Model-written prose, item/brand/channel names, source ids and
// evidence values are rendered exactly as persisted and are never touched
// here. English strings are byte-identical to the pre-existing UI copy.
//
// Which language: prefer the language stored WITH the advice revision being
// shown (a historical Russian revision stays consistent after the user
// switches to English); legacy revisions without one fall back to the user's
// current preference, then English.

import { DEFAULT_ADVICE_LANGUAGE, normalizeAdviceLanguage, type AdviceLanguage } from './adviceLanguage';

export interface AdviceLabels {
  // types / badges
  type: Record<'action' | 'observation' | 'watch' | 'review', string>;
  priority: Record<'high' | 'medium' | 'low', string>;
  confidenceLevel: Record<'stronger' | 'moderate' | 'low' | 'preliminary' | 'insufficient', string>;
  confidenceNotApplicable: string;
  confidencePrefix: string;
  // card / drawer sections
  advice: string;
  whyItMatters: string;
  suggestedChecks: string;
  evidenceHeading: string;
  evidenceFooter: string;
  limitations: string;
  actions: string;
  viewDetails: string;
  viewEvidence: string;
  dismiss: string;
  dismissFor30Days: string;
  dismissAdvice: string;
  hiding: string;
  hiddenFor30Days: string;
  openItem: string;
  viewLeads: string;
  marketWindowSubject: string;
  close: string;
  closeAdviceDetails: string;
  // section chrome
  latestAnalyticsAdvice: string;
  fromRunGenerated: string;
  generated: string;
  demandWindow: string;
  listingAdviceTitle: string;
  listingAdviceSubtitle: string;
  loading: string;
  unavailable: string;
  retry: string;
  noneYet: string;
  runAnalytics: string;
  noMaterialAdvice: string;
  allDismissed: string;
  allCoachAdviceDismissed: string;
  lastFailure: string;
  // Business Coach lifecycle (Dashboard + /listings) — {date}/{n}/{gen} placeholders
  businessCoach: string;
  weeklyRefresh: string;
  weeklyState: Record<'completed' | 'partial' | 'failed' | 'running' | 'did_not_run' | 'next_scheduled', string>;
  lastSuccessful: string;
  refreshCoach: string;
  refreshing: string;
  refreshAlreadyRunning: string;
  refreshFailed: string;
  latestRefreshFailed: string;
  coachNoneYet: string;
  noVisibleAdvice: string;
  hiddenCountOne: string;
  hiddenCountMany: string;
  nextResurface: string;
  viewHidden: string;
  hideHidden: string;
  hiddenUntil: string;
  resurface: string;
  noMaterialThisWeek: string;
  listingActions: string;
  viewAllInListings: string;
  noMaterialListingActions: string;
  listingNotRefreshedSince: string;
  listingAdviceAge: string;
  listingRefreshFailed: string;
  refreshAdvice: string;
  adviceUnchanged: string;
  // debug / audit
  debugAudit: string;
  model: string;
  prompt: string;
  language: string;
  inputHash: string;
  citedSources: string;
  run: string;
  copyPacket: string;
  copied: string;
}

const EN: AdviceLabels = {
  type: { action: 'Action', observation: 'Observation', watch: 'Watch', review: 'Review' },
  priority: { high: 'High priority', medium: 'Medium priority', low: 'Low priority' },
  confidenceLevel: { stronger: 'Stronger', moderate: 'Moderate', low: 'Low', preliminary: 'Preliminary', insufficient: 'Insufficient' },
  confidenceNotApplicable: 'Not applicable',
  confidencePrefix: 'Confidence',
  advice: 'Advice',
  whyItMatters: 'Why it matters',
  suggestedChecks: 'Suggested checks',
  evidenceHeading: 'Evidence the advice was based on',
  evidenceFooter: 'Shown as recorded when this advice was generated.',
  limitations: 'Limitations',
  actions: 'Actions',
  viewDetails: 'View details',
  viewEvidence: 'View Evidence',
  dismiss: 'Dismiss',
  dismissFor30Days: 'Dismiss for 30 days',
  dismissAdvice: 'Dismiss advice',
  hiding: 'Hiding…',
  hiddenFor30Days: 'Hidden for 30 days',
  openItem: 'Open Item',
  viewLeads: 'View Leads',
  marketWindowSubject: 'all leads in the 4-week window',
  close: 'Close',
  closeAdviceDetails: 'Close advice details',
  latestAnalyticsAdvice: 'Latest Analytics Advice',
  fromRunGenerated: 'From the Analytics Run generated',
  generated: 'Generated',
  demandWindow: '4-week demand window',
  listingAdviceTitle: 'Listing Advice',
  listingAdviceSubtitle: 'AI interpretation of your recent listing demand — separate from the facts below.',
  loading: 'Loading Listing Advice…',
  unavailable: 'Listing Advice is unavailable right now.',
  retry: 'Retry',
  noneYet: 'No Listing Advice has been generated yet.',
  runAnalytics: 'Run Analytics',
  noMaterialAdvice: 'No material listing advice for this window.',
  allDismissed: "You've dismissed all current Listing Advice. New advice appears after the next Analytics run.",
  allCoachAdviceDismissed: "You've dismissed every card from the latest Business Coach run. New advice appears after the next Analytics run; previously dismissed items stay hidden until their 30-day period ends.",
  lastFailure: 'The most recent Listing Advice update failed ({code}); the previous advice is shown.',
  businessCoach: 'Business Coach',
  weeklyRefresh: 'Weekly refresh',
  weeklyState: { completed: 'Completed', partial: 'Partially failed', failed: 'Failed', running: 'Running', did_not_run: 'Did not run', next_scheduled: 'Next' },
  lastSuccessful: 'Last successful',
  refreshCoach: 'Refresh Coach',
  refreshing: 'Refreshing…',
  refreshAlreadyRunning: 'A Coach refresh is already running.',
  refreshFailed: 'Refresh failed. Previous advice is still shown.',
  latestRefreshFailed: 'Latest refresh failed {date}. Using advice generated {gen}.',
  coachNoneYet: 'No Business Coach advice has been generated yet.',
  noVisibleAdvice: 'No new visible advice',
  hiddenCountOne: '1 current suggestion is hidden.',
  hiddenCountMany: '{n} current suggestions are hidden.',
  nextResurface: 'Next suggestion may resurface {date}.',
  viewHidden: 'View hidden suggestions',
  hideHidden: 'Hide list',
  hiddenUntil: 'Hidden until {date}',
  resurface: 'Resurface',
  noMaterialThisWeek: 'No material new advice this week.',
  listingActions: 'Listing Actions',
  viewAllInListings: 'View all in Listings',
  noMaterialListingActions: 'No material listing actions this week.',
  listingNotRefreshedSince: 'Listing advice has not refreshed since {date}.',
  listingAdviceAge: 'Listing advice is {n} weeks old.',
  listingRefreshFailed: 'Listing advice refresh failed. Previous advice is still shown.',
  refreshAdvice: 'Refresh Advice',
  adviceUnchanged: 'Already up to date for the current evidence.',
  debugAudit: 'Debug / audit',
  model: 'Model',
  prompt: 'Prompt',
  language: 'Language',
  inputHash: 'Input hash',
  citedSources: 'Cited sources',
  run: 'Run',
  copyPacket: 'Copy input packet',
  copied: 'Copied',
};

const RU: AdviceLabels = {
  type: { action: 'Действие', observation: 'Наблюдение', watch: 'Отслеживать', review: 'Проверка' },
  priority: { high: 'Высокий приоритет', medium: 'Средний приоритет', low: 'Низкий приоритет' },
  confidenceLevel: { stronger: 'Высокая', moderate: 'Средняя', low: 'Низкая', preliminary: 'Предварительная', insufficient: 'Недостаточная' },
  confidenceNotApplicable: 'Не применимо',
  confidencePrefix: 'Уверенность',
  advice: 'Совет',
  whyItMatters: 'Почему это важно',
  suggestedChecks: 'Что стоит проверить',
  evidenceHeading: 'Данные, на которых основан совет',
  evidenceFooter: 'Показано так, как было записано при создании этого совета.',
  limitations: 'Ограничения',
  actions: 'Действия',
  viewDetails: 'Подробнее',
  viewEvidence: 'Показать данные',
  dismiss: 'Скрыть',
  dismissFor30Days: 'Скрыть на 30 дней',
  dismissAdvice: 'Скрыть совет',
  hiding: 'Скрываю…',
  hiddenFor30Days: 'Скрыто на 30 дней',
  openItem: 'Открыть товар',
  viewLeads: 'Посмотреть лиды',
  marketWindowSubject: 'все лиды за 4 недели',
  close: 'Закрыть',
  closeAdviceDetails: 'Закрыть подробности совета',
  latestAnalyticsAdvice: 'Последние советы по аналитике',
  fromRunGenerated: 'По запуску аналитики от',
  generated: 'Создано',
  demandWindow: '4-недельное окно спроса',
  listingAdviceTitle: 'Советы по объявлениям',
  listingAdviceSubtitle: 'ИИ-интерпретация недавнего спроса на ваши объявления — отдельно от фактов ниже.',
  loading: 'Загрузка советов по объявлениям…',
  unavailable: 'Советы по объявлениям сейчас недоступны.',
  retry: 'Повторить',
  noneYet: 'Советы по объявлениям ещё не создавались.',
  runAnalytics: 'Запустить аналитику',
  noMaterialAdvice: 'Существенных советов по объявлениям для этого периода нет.',
  allDismissed: 'Вы скрыли все текущие советы по объявлениям. Новые появятся после следующего запуска аналитики.',
  allCoachAdviceDismissed: 'Вы скрыли все карточки из последнего запуска Бизнес-коуча. Новые советы появятся после следующего запуска аналитики; ранее скрытые карточки останутся скрытыми до истечения их 30-дневного периода.',
  lastFailure: 'Последнее обновление советов по объявлениям не удалось ({code}); показаны предыдущие советы.',
  businessCoach: 'Бизнес-коуч',
  weeklyRefresh: 'Еженедельное обновление',
  weeklyState: { completed: 'Выполнено', partial: 'Частично не удалось', failed: 'Не удалось', running: 'Выполняется', did_not_run: 'Не запускалось', next_scheduled: 'Следующее' },
  lastSuccessful: 'Последнее успешное',
  refreshCoach: 'Обновить коуча',
  refreshing: 'Обновляю…',
  refreshAlreadyRunning: 'Обновление коуча уже выполняется.',
  refreshFailed: 'Обновление не удалось. Показаны предыдущие советы.',
  latestRefreshFailed: 'Последнее обновление не удалось {date}. Показаны советы от {gen}.',
  coachNoneYet: 'Советы Бизнес-коуча ещё не создавались.',
  noVisibleAdvice: 'Нет новых видимых советов',
  hiddenCountOne: 'Скрыт 1 текущий совет.',
  hiddenCountMany: 'Скрыто текущих советов: {n}.',
  nextResurface: 'Следующий совет может вернуться {date}.',
  viewHidden: 'Показать скрытые советы',
  hideHidden: 'Свернуть',
  hiddenUntil: 'Скрыто до {date}',
  resurface: 'Вернуть',
  noMaterialThisWeek: 'На этой неделе существенных новых советов нет.',
  listingActions: 'Действия по объявлениям',
  viewAllInListings: 'Все в разделе «Объявления»',
  noMaterialListingActions: 'На этой неделе существенных действий по объявлениям нет.',
  listingNotRefreshedSince: 'Советы по объявлениям не обновлялись с {date}.',
  listingAdviceAge: 'Советам по объявлениям {n} нед.',
  listingRefreshFailed: 'Обновление советов по объявлениям не удалось. Показаны предыдущие.',
  refreshAdvice: 'Обновить советы',
  adviceUnchanged: 'Советы уже актуальны для текущих данных.',
  debugAudit: 'Отладка / аудит',
  model: 'Модель',
  prompt: 'Промпт',
  language: 'Язык',
  inputHash: 'Хэш входных данных',
  citedSources: 'Использованные источники',
  run: 'Запуск',
  copyPacket: 'Скопировать входной пакет',
  copied: 'Скопировано',
};

const LABELS: Record<AdviceLanguage, AdviceLabels> = { en: EN, ru: RU };

export function adviceLabels(language: unknown): AdviceLabels {
  return LABELS[normalizeAdviceLanguage(language)];
}

/**
 * Language for Advice chrome: the language stored with the revision when
 * present and valid, else the viewer's current preference, else English.
 */
export function resolveRevisionLanguage(stored: unknown, viewerPreference?: unknown): AdviceLanguage {
  if (stored === 'en' || stored === 'ru') return stored;
  return viewerPreference === 'en' || viewerPreference === 'ru' ? viewerPreference : DEFAULT_ADVICE_LANGUAGE;
}

const DATE_LOCALE: Record<AdviceLanguage, string> = { en: 'en-US', ru: 'ru-RU' };

/** Date only ("Nov 5" / "5 нояб."), for freshness lines. */
export function formatAdviceDate(value: string | null | undefined, language: AdviceLanguage): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(DATE_LOCALE[language], { month: 'short', day: 'numeric' });
}

/** "{n} current suggestions are hidden." with the right singular/plural form. */
export function hiddenCountLabel(L: AdviceLabels, n: number): string {
  return n === 1 ? L.hiddenCountOne : L.hiddenCountMany.replace('{n}', String(n));
}

/** Date/time in the advice language (the existing English format is unchanged). */
export function formatAdviceTimestamp(value: string | null | undefined, language: AdviceLanguage): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(DATE_LOCALE[language], { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}
