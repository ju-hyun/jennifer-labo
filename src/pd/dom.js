/**
 * PD 画面で参照する DOM 要素 (ES モジュールは DOM 解析後に評価される)
 */

export const $ = (id) => document.getElementById(id);

export const el = {
  breadcrumb: $('breadcrumbContainer'),
  typeInstance: $('typeInstance'),
  typeBusiness: $('typeBusiness'),
  instanceArea: $('instanceFilterArea'),
  businessArea: $('businessFilterArea'),
  instanceSelect: $('instanceSelect'),
  businessSelect: $('businessSelect'),
  presetGroup: $('presetGroup'),
  startInput: $('startInput'),
  endInput: $('endInput'),
  chunkBadge: $('chunkBadge'),
  fetchBtn: $('fetchBtn'),
  abortBtn: $('abortBtn'),
  progressCard: $('progressCard'),
  progressBar: $('progressBar'),
  progressText: $('progressText'),
  notice: $('noticeBar'),
  histogramTitle: $('histogramTitle'),
  histogramCanvas: $('histogramCanvas'),
  cdfCanvas: $('cdfCanvas'),
  rankingCanvas: $('rankingCanvas'),
  errorModeSelect: $('errorModeSelect'),
  appKeyword: $('appKeyword'),
  binModeSelect: $('binModeSelect'),
  manualBinArea: $('manualBinArea'),
  binWidthInput: $('binWidthInput'),
  xMaxInput: $('xMaxInput'),
  logYToggle: $('logYToggle'),
  tailZoomToggle: $('tailZoomToggle'),
  compareToggle: $('compareToggle'),
  pctToggles: $('pctToggles'),
  resetFilterBtn: $('resetFilterBtn'),
  csvBtn: $('csvBtn')
};

/* ------------------------------------------------------------------ */
/* ユーティリティ                                                      */
/* ------------------------------------------------------------------ */
