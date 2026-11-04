/**
 * PTA 画面で共通して参照する DOM 要素 (ES モジュールは DOM 解析後に評価される)
 */

// DOM Elements
export const instanceSelect = document.getElementById('instanceSelect');

export const businessSelect = document.getElementById('businessSelect');

export const instanceFilterArea = document.getElementById('instanceFilterArea');

export const businessFilterArea = document.getElementById('businessFilterArea');

export const typeRadios = document.querySelectorAll('input[name="targetType"]');

export const btnSysCpu = document.getElementById('btnSysCpu');

export const btnHeapUsage = document.getElementById('btnHeapUsage');
