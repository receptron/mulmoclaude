<template>
  <div class="flex flex-col gap-3" data-testid="accounting-balance-sheet">
    <div class="flex flex-wrap items-end gap-3">
      <label class="text-xs text-gray-500 flex flex-col gap-1">
        {{ t("pluginAccounting.balanceSheet.shortcutLabel") }}
        <select
          :value="selectedShortcut"
          class="h-8 px-2 rounded border border-gray-300 text-sm bg-white"
          data-testid="accounting-bs-shortcut"
          @change="onShortcutChange"
        >
          <option value="" hidden></option>
          <option value="thisMonth">{{ t("pluginAccounting.balanceSheet.thisMonth") }}</option>
          <option value="lastMonth">{{ t("pluginAccounting.balanceSheet.lastMonth") }}</option>
          <option value="lastQuarter">{{ t("pluginAccounting.balanceSheet.lastQuarter") }}</option>
          <option value="lastYear">{{ t("pluginAccounting.balanceSheet.lastYear") }}</option>
        </select>
      </label>
      <label class="text-xs text-gray-500 flex flex-col gap-1">
        {{ t("pluginAccounting.balanceSheet.asOfLabel") }}
        <input v-model="period" type="month" class="h-8 px-2 rounded border border-gray-300 text-sm" data-testid="accounting-bs-period" />
      </label>
      <button class="h-8 px-2.5 rounded border border-gray-300 text-sm text-gray-600 hover:bg-gray-50" @click="refresh">
        <span class="material-icons text-base align-middle">refresh</span>
      </button>
    </div>
    <p v-if="loading" class="text-xs text-gray-400">{{ t("pluginAccounting.common.loading") }}</p>
    <p v-else-if="error" class="text-xs text-red-500">{{ t("pluginAccounting.common.error", { error }) }}</p>
    <template v-else-if="balanceSheet">
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <section v-for="section in balanceSheet.sections" :key="section.type" class="border border-gray-200 rounded p-3">
          <h4 class="text-sm font-semibold mb-2">{{ sectionLabel(section.type) }}</h4>
          <table class="w-full text-sm">
            <tbody>
              <tr
                v-for="row in section.rows"
                :key="row.accountCode"
                class="border-b border-gray-100"
                :class="
                  isEarningsRow(row)
                    ? 'italic text-gray-600'
                    : 'hover:bg-blue-50 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400'
                "
                :tabindex="isEarningsRow(row) ? -1 : 0"
                :role="isEarningsRow(row) ? undefined : 'button'"
                :aria-label="isEarningsRow(row) ? undefined : t('pluginAccounting.accounts.openLedgerAria', { code: row.accountCode, name: row.accountName })"
                :data-testid="isEarningsRow(row) ? undefined : `accounting-bs-row-${row.accountCode}`"
                @click="onRowClick(row)"
                @keydown.enter.prevent.self="onKeyActivate($event, row)"
                @keydown.space.prevent.self="onKeyActivate($event, row)"
              >
                <td class="py-1 px-1">
                  <span v-if="!isEarningsRow(row)" class="font-mono text-[10px] text-gray-400 mr-2">{{ row.accountCode }}</span>{{ rowName(row) }}
                </td>
                <td class="py-1 px-1 text-right font-mono">{{ formatAmount(row.balance) }}</td>
              </tr>
            </tbody>
            <tfoot>
              <tr class="font-semibold border-t border-gray-300">
                <td class="py-1 px-1">{{ t("pluginAccounting.balanceSheet.total") }}</td>
                <td class="py-1 px-1 text-right">{{ formatAmount(section.total) }}</td>
              </tr>
            </tfoot>
          </table>
        </section>
      </div>
      <p :class="Math.abs(balanceSheet.imbalance) <= 0.01 ? 'text-green-600' : 'text-red-500'" class="text-xs" data-testid="accounting-bs-imbalance">
        {{ t("pluginAccounting.balanceSheet.imbalance", { amount: formatAmount(balanceSheet.imbalance) }) }}
      </p>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useAccountingI18n } from "../lang";
import { useAccountingApi, type BalanceSheet } from "../api";
import {
  formatAmount as formatAmountWithCurrency,
  decemberOfPreviousYearString,
  lastMonthOfPreviousQuarterString,
  localMonthString,
  previousMonthString,
} from "../../shared";
import { useLatestRequest } from "./useLatestRequest";

const api = useAccountingApi();

const { t } = useAccountingI18n();

const props = defineProps<{ bookId: string; currency: string; version: number }>();
const emit = defineEmits<{ selectAccount: [code: string] }>();

const period = ref(localMonthString());
const balanceSheet = ref<BalanceSheet | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);
const { begin: beginRequest, isCurrent } = useLatestRequest();

function formatAmount(value: number): string {
  return formatAmountWithCurrency(value, props.currency);
}

function sectionLabel(type: string): string {
  if (type === "asset") return t("pluginAccounting.balanceSheet.sections.asset");
  if (type === "liability") return t("pluginAccounting.balanceSheet.sections.liability");
  if (type === "equity") return t("pluginAccounting.balanceSheet.sections.equity");
  return type;
}

// The server adds a synthetic "Current period earnings" row to the
// Equity section so the B/S balances during the period (before
// closing entries fold income/expense into Retained Earnings).
// `_currentEarnings` is the sentinel accountCode emitted by the
// server — see CURRENT_EARNINGS_ACCOUNT_CODE in
// server/accounting/report.ts.
const CURRENT_EARNINGS_ACCOUNT_CODE = "_currentEarnings";

interface BSRow {
  accountCode: string;
  accountName: string;
  balance: number;
}

function isEarningsRow(row: BSRow): boolean {
  return row.accountCode === CURRENT_EARNINGS_ACCOUNT_CODE;
}

function rowName(row: BSRow): string {
  return isEarningsRow(row) ? t("pluginAccounting.balanceSheet.currentEarnings") : row.accountName;
}

// Earnings row is synthetic (no underlying account on file), so it
// can't be drilled into. Real-account rows route to the Ledger tab
// pre-filtered to that account — same pattern as AccountsList.
function onRowClick(row: BSRow): void {
  if (isEarningsRow(row)) return;
  emit("selectAccount", row.accountCode);
}

function onKeyActivate(event: KeyboardEvent, row: BSRow): void {
  if (event.repeat) return;
  if (isEarningsRow(row)) return;
  emit("selectAccount", row.accountCode);
}

// Mirrors the DateRangePicker pattern: hidden "" sentinel for the
// "no preset matches" custom state, otherwise the dropdown shows
// whichever shortcut produces the current period. Re-evaluates `now`
// on every read so the labels stay correct across midnight without
// any cache-invalidation plumbing.
type Shortcut = "thisMonth" | "lastMonth" | "lastQuarter" | "lastYear";
type SelectedShortcut = Shortcut | "";

const selectedShortcut = computed<SelectedShortcut>(() => {
  const { value } = period;
  const now = new Date();
  if (value === localMonthString(now)) return "thisMonth";
  if (value === previousMonthString(now)) return "lastMonth";
  if (value === lastMonthOfPreviousQuarterString(now)) return "lastQuarter";
  if (value === decemberOfPreviousYearString(now)) return "lastYear";
  return "";
});

function onShortcutChange(event: Event): void {
  const { target } = event;
  if (!(target instanceof HTMLSelectElement)) return;
  const raw = target.value;
  const now = new Date();
  if (raw === "thisMonth") period.value = localMonthString(now);
  else if (raw === "lastMonth") period.value = previousMonthString(now);
  else if (raw === "lastQuarter") period.value = lastMonthOfPreviousQuarterString(now);
  else if (raw === "lastYear") period.value = decemberOfPreviousYearString(now);
}

async function refresh(): Promise<void> {
  const token = beginRequest();
  loading.value = true;
  error.value = null;
  try {
    const result = await api.getBalanceSheet({ kind: "month", period: period.value }, props.bookId);
    if (!isCurrent(token)) return;
    if (!result.ok) {
      error.value = result.error;
      balanceSheet.value = null;
      return;
    }
    balanceSheet.value = result.data.balanceSheet;
  } finally {
    if (isCurrent(token)) loading.value = false;
  }
}

watch(() => [props.bookId, props.version, period.value], refresh, { immediate: true });
</script>
