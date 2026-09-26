<template>
  <!-- One record panel for both open (read-only) and edit/create. The
       layout is IDENTICAL across modes — same header skeleton, same field
       grid, same per-field cell geometry — and only the inner control of
       each cell swaps: a formatted value when viewing, an input when
       editing. The root is a <form> while editing (so the Save button
       submits) and a <div> when viewing. The host (modal / calendar day
       view) supplies the surrounding container. -->
  <component :is="editing ? 'form' : 'div'" class="px-6 py-5 max-h-[60vh] overflow-y-auto" :data-testid="rootTestid" @submit.prevent="emit('submit')">
    <!-- Header: title block (left) is identical in both modes; only the
         right-hand button cluster swaps (Cancel/Save ↔ actions/Edit/Delete/
         Close). Same height + margin so nothing shifts on toggle. -->
    <div class="flex items-center gap-2 mb-4">
      <div class="flex-1 min-w-0">
        <span class="block text-[9px] font-bold text-slate-400 uppercase tracking-wider">{{ collection.title }}</span>
        <h2 class="text-base font-bold text-slate-800 truncate" :data-testid="editing ? 'collections-edit-title' : 'collections-detail-title'">
          {{ headerTitle }}
        </h2>
      </div>

      <!-- Edit/create actions -->
      <template v-if="editing">
        <button
          type="button"
          class="h-8 px-2.5 rounded text-xs font-bold text-slate-500 hover:bg-slate-200/50 transition-colors"
          data-testid="collections-editor-cancel"
          @click="emit('cancel')"
        >
          {{ t("common.cancel") }}
        </button>
        <button
          type="submit"
          class="h-8 px-2.5 rounded bg-indigo-600 text-white font-bold text-xs hover:bg-indigo-700 disabled:opacity-50 transition-all shadow-sm shadow-indigo-600/10"
          :disabled="saving"
          data-testid="collections-editor-save"
        >
          {{ saving ? t("common.saving") : t("common.save") }}
        </button>
      </template>

      <!-- Read-only actions -->
      <div v-else class="flex items-center gap-2">
        <button
          v-for="action in visibleActions"
          :key="action.id"
          type="button"
          class="h-8 px-2.5 rounded border border-indigo-200 bg-indigo-50/50 text-indigo-600 hover:bg-indigo-600 hover:text-white hover:border-indigo-600 font-bold text-xs transition-all flex items-center gap-1 disabled:opacity-50"
          :disabled="actionPending || runningActionIds.includes(action.id)"
          :data-testid="`collections-detail-action-${action.id}`"
          @click="emit('runAction', action)"
        >
          <!-- A running `kind:"agent"` worker replaces the icon with a spinner
               until the completion ping's refetch clears its run key. -->
          <span v-if="runningActionIds.includes(action.id)" class="material-symbols-outlined text-sm animate-spin">progress_activity</span>
          <IconGlyph v-else-if="action.icon" :icon="action.icon" size-class="text-sm" />
          <span>{{ action.label }}</span>
        </button>

        <!-- Edit/Delete are absent (not disabled) on a read-only dataSource
             collection — the server would answer 405 anyway. -->
        <button
          v-if="!readonly"
          type="button"
          class="h-8 px-2.5 rounded border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 font-bold text-xs transition-all flex items-center gap-1"
          data-testid="collections-detail-edit"
          @click="emit('edit')"
        >
          <span class="material-icons text-sm">edit</span>
          <span>{{ t("collectionsView.editItem") }}</span>
        </button>

        <button
          v-if="!readonly"
          type="button"
          class="h-8 px-2.5 rounded border border-rose-200 bg-white text-rose-600 hover:bg-rose-50 font-bold text-xs transition-all flex items-center gap-1"
          data-testid="collections-detail-remove"
          @click="emit('delete')"
        >
          <span class="material-icons text-sm">delete</span>
          <span>{{ t("common.remove") }}</span>
        </button>

        <button
          type="button"
          class="h-8 w-8 flex items-center justify-center rounded text-slate-400 hover:bg-slate-100 hover:text-slate-600 transition-colors"
          :aria-label="t('common.close')"
          data-testid="collections-detail-close"
          @click="emit('close')"
        >
          <span class="material-icons text-lg">close</span>
        </button>
      </div>
    </div>

    <p
      v-if="!editing && actionError"
      class="mb-3 text-xs font-semibold text-red-600 bg-red-50 border border-red-100 p-2.5 rounded-xl shadow-sm"
      data-testid="collections-detail-action-error"
    >
      {{ actionError }}
    </p>

    <!-- Field grid: same columns + per-field cell in both modes. Each cell
         renders its edit control while editing (and the field is editable),
         else its read-only display. -->
    <div class="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-4 bg-white rounded-2xl border border-slate-200/60 p-6 shadow-sm">
      <template v-for="(field, key) in collection.schema.fields" :key="key">
        <div v-if="cellVisible(field, String(key))" class="flex flex-col gap-1.5" :class="colSpanClass(field)">
          <label class="text-[10px] font-bold text-slate-400 uppercase tracking-wider flex items-center gap-1" :for="`collections-field-${key}`">
            {{ field.label }}
            <!-- eslint-disable-next-line @intlify/vue-i18n/no-raw-text -- bare "*" is a universal required-field glyph; treating it as i18n copy would force eight translations of the same symbol. -->
            <span v-if="editing && field.required" class="text-rose-500 font-bold">*</span>
          </label>

          <!-- Embed per-record picker: a dropdown of the target collection's
               records whose selection is stored in the embed's `idField`. The
               read-only block renders below (in view mode) from that value. -->
          <select
            v-if="editing && field.type === 'embed' && field.idField && render.embedOptions(field.to ?? '').length > 0"
            :id="`collections-field-${key}`"
            v-model="editing.text[field.idField]"
            :required="embedPickerRequired(field)"
            class="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs bg-slate-50 hover:bg-slate-50/50 focus:bg-white focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 focus:outline-none transition-all cursor-pointer font-medium text-slate-700"
            :data-testid="`collections-input-${key}`"
          >
            <option value="">{{ t("collectionsView.selectPlaceholder") }}</option>
            <option v-for="opt in render.embedOptions(field.to ?? '')" :key="opt.slug" :value="opt.slug">{{ opt.display }}</option>
          </select>

          <!-- Fallback when the target collection has no records yet (or hasn't
               loaded): a plain id input, so a required embed can still be filled
               and submitted — mirrors the ref field's empty-options behavior. -->
          <input
            v-else-if="editing && field.type === 'embed' && field.idField"
            :id="`collections-field-${key}`"
            v-model="editing.text[field.idField]"
            type="text"
            :required="embedPickerRequired(field)"
            :placeholder="t('collectionsView.selectPlaceholder')"
            class="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 focus:outline-none font-medium text-slate-700 transition-all"
            :data-testid="`collections-input-${key}`"
          />

          <!-- ===== EDIT CONTROLS (editable field types only) ===== -->
          <template v-else-if="editing && isEditableType(field.type)">
            <!-- Boolean checkbox -->
            <label v-if="field.type === 'boolean'" class="inline-flex items-center gap-2.5 text-sm text-slate-700 cursor-pointer select-none">
              <input
                :id="`collections-field-${key}`"
                v-model="editing.bool[key]"
                type="checkbox"
                class="h-5 w-5 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500/20 cursor-pointer"
                :data-testid="`collections-input-${key}`"
                @change="markBoolTouched(String(key))"
              />
              <span class="text-xs font-semibold" :class="editing.bool[key] ? 'text-indigo-600' : 'text-slate-500'">
                {{ editing.bool[key] ? t("common.yes") : t("common.no") }}
              </span>
            </label>

            <!-- Ref selector -->
            <select
              v-else-if="field.type === 'ref' && field.to && render.refOptions(field.to).length > 0"
              :id="`collections-field-${key}`"
              v-model="editing.text[key]"
              :required="isFieldRequiredInUi(field)"
              class="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs bg-slate-50 hover:bg-slate-50/50 focus:bg-white focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 focus:outline-none transition-all cursor-pointer font-medium text-slate-700"
              :data-testid="`collections-input-${key}`"
            >
              <option value="">{{ t("collectionsView.selectPlaceholder") }}</option>
              <option v-for="opt in render.refOptions(field.to)" :key="opt.slug" :value="opt.slug">{{ opt.display }}</option>
            </select>

            <!-- Enum selector -->
            <select
              v-else-if="field.type === 'enum' && Array.isArray(field.values) && field.values.length > 0"
              :id="`collections-field-${key}`"
              v-model="editing.text[key]"
              :required="isFieldRequiredInUi(field)"
              class="w-full rounded-xl border px-3 py-2 text-xs focus:bg-white focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 focus:outline-none transition-all cursor-pointer font-medium"
              :class="enumControlClass(String(key), editing.text[key])"
              :data-testid="`collections-input-${key}`"
            >
              <option value="">{{ t("collectionsView.selectPlaceholder") }}</option>
              <option v-for="value in field.values" :key="value" :value="value">{{ value }}</option>
            </select>

            <!-- Nested Table editor -->
            <div
              v-else-if="field.type === 'table' && field.of"
              class="border border-slate-200 bg-slate-50/30 rounded-xl p-4 space-y-3"
              :data-testid="`collections-table-${key}`"
            >
              <div v-if="editing.table[key] && editing.table[key].length > 0" class="overflow-hidden border border-slate-200 rounded-lg shadow-sm">
                <table class="w-full text-xs text-slate-600 bg-white">
                  <thead class="bg-slate-50 border-b border-slate-200 text-slate-500 font-bold uppercase tracking-wider">
                    <tr>
                      <th v-for="(subField, subKey) in field.of" :key="subKey" class="text-left px-3 py-2 font-bold">{{ subField.label }}</th>
                      <th class="w-9"></th>
                    </tr>
                  </thead>
                  <tbody class="divide-y divide-slate-100">
                    <tr v-for="(row, rowIdx) in editing.table[key]" :key="rowIdx" class="hover:bg-slate-50/50">
                      <td v-for="(subField, subKey) in field.of" :key="subKey" class="px-2 py-1.5 align-middle">
                        <input
                          v-if="subField.type === 'boolean'"
                          v-model="row.bool[subKey]"
                          type="checkbox"
                          class="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500/20 cursor-pointer"
                          @change="markRowBoolTouched(row, String(subKey))"
                        />
                        <select
                          v-else-if="subField.type === 'enum' && Array.isArray(subField.values) && subField.values.length > 0"
                          v-model="row.text[subKey]"
                          :required="subField.required"
                          class="w-full rounded-lg border border-slate-200 px-2 py-1 text-xs focus:border-indigo-500 focus:outline-none cursor-pointer bg-slate-50 font-medium"
                        >
                          <option value="">{{ t("collectionsView.selectPlaceholder") }}</option>
                          <option v-for="value in subField.values" :key="value" :value="value">{{ value }}</option>
                        </select>
                        <select
                          v-else-if="subField.type === 'ref' && subField.to && render.refOptions(subField.to).length > 0"
                          v-model="row.text[subKey]"
                          :required="subField.required"
                          class="w-full rounded-lg border border-slate-200 px-2 py-1 text-xs focus:border-indigo-500 focus:outline-none cursor-pointer bg-slate-50 font-medium"
                        >
                          <option value="">{{ t("collectionsView.selectPlaceholder") }}</option>
                          <option v-for="opt in render.refOptions(subField.to)" :key="opt.slug" :value="opt.slug">{{ opt.display }}</option>
                        </select>
                        <div v-else-if="subField.type === 'money'" class="relative flex items-center">
                          <span class="absolute left-1.5 text-[10px] text-slate-400 font-bold pr-1 border-r border-slate-200">{{
                            render.currencySymbol(render.resolveCurrency(subField, liveRecord))
                          }}</span>
                          <input
                            v-model="row.text[subKey]"
                            type="number"
                            step="0.01"
                            :required="subField.required"
                            class="w-full rounded-lg border border-slate-200 pl-6 pr-1.5 py-1 text-xs focus:border-indigo-500 focus:outline-none font-semibold text-slate-800"
                          />
                        </div>
                        <input
                          v-else
                          v-model="row.text[subKey]"
                          :type="render.inputTypeFor(subField.type, row.text[subKey])"
                          :step="render.stepFor(subField.type)"
                          :required="subField.required"
                          class="w-full rounded-lg border border-slate-200 px-2 py-1 text-xs focus:border-indigo-500 focus:outline-none font-medium text-slate-700"
                        />
                      </td>
                      <td class="text-center px-1">
                        <button
                          type="button"
                          class="h-7 w-7 flex items-center justify-center rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50 transition-colors"
                          :aria-label="t('collectionsView.removeRow')"
                          :data-testid="`collections-table-${key}-remove-${rowIdx}`"
                          @click="removeTableRow(String(key), rowIdx)"
                        >
                          <span class="material-icons text-base">close</span>
                        </button>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <p v-else class="text-xs text-slate-400 italic">{{ t("collectionsView.noRows") }}</p>
              <button
                type="button"
                class="inline-flex items-center gap-1 text-xs text-indigo-600 hover:text-indigo-800 font-bold hover:underline"
                :data-testid="`collections-table-${key}-add`"
                @click="addTableRow(String(key), field.of)"
              >
                <span class="material-icons text-xs">add</span>
                <span>{{ t("collectionsView.addRow") }}</span>
              </button>
            </div>

            <!-- Money input field -->
            <div v-else-if="field.type === 'money'" class="relative flex items-center">
              <div class="absolute left-3 text-slate-400 font-bold text-xs select-none pr-1.5 border-r border-slate-200">
                {{ render.currencySymbol(render.resolveCurrency(field, liveRecord)) }}
              </div>
              <input
                :id="`collections-field-${key}`"
                v-model="editing.text[key]"
                type="number"
                step="0.01"
                :required="isFieldRequiredInUi(field)"
                class="w-full rounded-xl border border-slate-200 pl-11 pr-3 py-2 text-xs focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 focus:outline-none font-semibold text-slate-800 transition-all"
                :data-testid="`collections-input-${key}`"
              />
            </div>

            <!-- Scalar inputs -->
            <input
              v-else-if="['string', 'email', 'number', 'date', 'datetime', 'ref', 'image', 'file'].includes(field.type)"
              :id="`collections-field-${key}`"
              v-model="editing.text[key]"
              :type="render.inputTypeFor(field.type, editing.text[key])"
              :step="render.stepFor(field.type)"
              :required="isFieldRequiredInUi(field)"
              :disabled="
                (field.primary === true && (editing.mode === 'edit' || isSingleton)) || (field.type === 'datetime' && render.isServerStamped(editing.text[key]))
              "
              class="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 focus:outline-none disabled:bg-slate-100 disabled:text-slate-400 font-medium text-slate-700 transition-all"
              :data-testid="`collections-input-${key}`"
            />

            <!-- Markdown or long text -->
            <textarea
              v-else
              :id="`collections-field-${key}`"
              v-model="editing.text[key]"
              :rows="field.type === 'markdown' ? 5 : 3"
              :required="isFieldRequiredInUi(field)"
              class="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 focus:outline-none font-medium text-slate-700 transition-all"
              :data-testid="`collections-input-${key}`"
            />
          </template>

          <!-- ===== READ-ONLY DISPLAY (viewing, or non-editable types) ===== -->
          <div v-else class="text-xs font-medium text-slate-700 break-words" :data-testid="`collections-detail-value-${key}`">
            <!-- Toggle state (read-only reflection of the projected enum). -->
            <template v-if="field.type === 'toggle'">
              <span
                v-if="field.field !== undefined && String(detailRecord[field.field] ?? '') === field.onValue"
                class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200/40"
              >
                <span class="h-1.5 w-1.5 rounded-full bg-emerald-500"></span>
                {{ t("common.yes") }}
              </span>
              <span
                v-else
                class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-slate-50 text-slate-400 border border-slate-200/20"
              >
                {{ t("common.no") }}
              </span>
            </template>

            <!-- Boolean state -->
            <template v-else-if="field.type === 'boolean'">
              <span
                v-if="detailRecord[key] === true"
                class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200/40"
              >
                <span class="h-1.5 w-1.5 rounded-full bg-emerald-500"></span>
                {{ t("common.yes") }}
              </span>
              <span
                v-else-if="detailRecord[key] === false"
                class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-slate-50 text-slate-400 border border-slate-200/20"
              >
                {{ t("common.no") }}
              </span>
              <!-- eslint-disable-next-line @intlify/vue-i18n/no-raw-text -- bare "—" for an omitted boolean: distinct from an explicit false. -->
              <span v-else class="text-slate-300">—</span>
            </template>

            <!-- Flag state (computed boolean predicate — total, so always
                 yes or no; never stored, nothing to edit). -->
            <template v-else-if="field.type === 'flag'">
              <span
                v-if="render.deriveRecord(detailRecord)[key] === true"
                class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200/40"
                :data-testid="`collections-detail-flag-${key}`"
              >
                <span class="h-1.5 w-1.5 rounded-full bg-emerald-500"></span>
                {{ t("common.yes") }}
              </span>
              <span
                v-else
                class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-slate-50 text-slate-400 border border-slate-200/20"
                :data-testid="`collections-detail-flag-${key}`"
              >
                {{ t("common.no") }}
              </span>
            </template>

            <!-- Ref details link -->
            <a
              v-else-if="field.type === 'ref' && field.to && typeof detailRecord[key] === 'string' && detailRecord[key]"
              :href="cui.recordHref?.(field.to, String(detailRecord[key]))"
              :tabindex="cui.recordHref?.(field.to, String(detailRecord[key])) ? undefined : 0"
              role="link"
              class="text-indigo-600 hover:text-indigo-800 font-bold hover:underline"
              :data-testid="`collections-detail-ref-${key}`"
              @click="activateRefLink($event, field.to, String(detailRecord[key]))"
              @keydown.enter="activateRefLink($event, field.to, String(detailRecord[key]))"
              @keydown.space="activateRefLink($event, field.to, String(detailRecord[key]))"
              >{{ render.refDisplay(field.to, String(detailRecord[key])) }}</a
            >

            <!-- Money format -->
            <span v-else-if="field.type === 'money'" class="font-semibold text-slate-900 tabular-nums text-sm">{{
              render.formatMoney(detailRecord[key], render.resolveCurrency(field, detailRecord), locale)
            }}</span>

            <!-- Derived formula badge -->
            <span
              v-else-if="field.type === 'derived'"
              class="inline-block truncate tabular-nums font-bold text-indigo-900 bg-indigo-50/50 px-2 py-0.5 rounded border border-indigo-100/50"
              >{{ render.derivedDisplay(field, render.evaluateDerivedAgainstItem(field, String(key), detailRecord), detailRecord) }}</span
            >

            <!-- Rollup aggregate badge (cross-collection) -->
            <span
              v-else-if="field.type === 'rollup'"
              class="inline-block truncate tabular-nums font-bold text-indigo-900 bg-indigo-50/50 px-2 py-0.5 rounded border border-indigo-100/50"
              :data-testid="`collections-detail-rollup-${key}`"
              >{{ render.rollupDisplay(field, detailRecord) }}</span
            >

            <!-- Sub table -->
            <div
              v-else-if="field.type === 'table' && field.of && render.hasTableRows(detailRecord[key])"
              class="border border-slate-200/80 rounded-xl overflow-hidden shadow-sm mt-1"
            >
              <table class="w-full text-[11px] text-slate-600 bg-white">
                <thead class="bg-slate-50 border-b border-slate-200 text-slate-500 font-bold uppercase tracking-wider">
                  <tr>
                    <th v-for="(subField, subKey) in field.of" :key="subKey" class="text-left px-4 py-2 font-bold">{{ subField.label }}</th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-slate-100">
                  <tr v-for="(row, rowIdx) in render.tableRows(detailRecord[key])" :key="rowIdx" class="hover:bg-slate-50/50">
                    <td v-for="(subField, subKey) in field.of" :key="subKey" class="px-4 py-2 align-middle font-medium">
                      <template v-if="subField.type === 'boolean'">
                        <span v-if="row[subKey] === true" class="material-icons text-emerald-600 text-base">check_circle</span>
                        <!-- eslint-disable-next-line @intlify/vue-i18n/no-raw-text -- bare "—" empty-value glyph (boolean=false), same as elsewhere. -->
                        <span v-else class="text-slate-300">—</span>
                      </template>
                      <span v-else :class="[subField.type === 'money' ? 'font-bold text-slate-800 tabular-nums' : '']">{{
                        render.formatSubCell(subField, row[subKey], detailRecord)
                      }}</span>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            <span v-else-if="field.type === 'table'" class="text-slate-400 italic">{{ t("collectionsView.noRows") }}</span>

            <!-- Markdown blocks with scroll area -->
            <div
              v-else-if="field.type === 'markdown'"
              class="bg-slate-50 rounded-xl p-4 border border-slate-200/60 text-slate-600 text-xs whitespace-pre-wrap leading-relaxed max-h-[30vh] overflow-y-auto"
            >
              {{ render.detailText(detailRecord[key]) }}
            </div>

            <!-- Embed view -->
            <CollectionEmbedView v-else-if="field.type === 'embed' && embedViews[key]" :view="embedViews[key]" :field-key="String(key)" />

            <!-- Backlinks: read-only reverse-ref sub-table -->
            <CollectionBacklinksView v-else-if="field.type === 'backlinks' && backlinksViews[key]" :view="backlinksViews[key]" :field-key="String(key)" />

            <!-- Image (workspace-relative path → <img> via auth-exempt /api/files/raw) -->
            <img
              v-else-if="field.type === 'image' && typeof detailRecord[key] === 'string' && detailRecord[key]"
              :src="resolveImageSrc(String(detailRecord[key]))"
              :alt="field.label"
              class="max-h-64 max-w-full object-contain rounded-lg border border-slate-200 bg-slate-50"
              :data-testid="`collections-detail-image-${key}`"
            />

            <!-- URL string → external link (new tab). -->
            <a
              v-else-if="field.type !== 'file' && render.isExternalUrl(detailRecord[key])"
              :href="String(detailRecord[key])"
              target="_blank"
              rel="noopener noreferrer"
              class="text-blue-600 hover:text-blue-800 font-semibold hover:underline break-all"
              :data-testid="`collections-detail-url-${key}`"
              >{{ String(detailRecord[key]) }}</a
            >

            <!-- File: served HTML/SVG artifact → open the rendered app in a new tab. -->
            <a
              v-else-if="field.type === 'file' && render.artifactUrl(detailRecord[key])"
              :href="render.artifactUrl(detailRecord[key]) ?? undefined"
              target="_blank"
              rel="noopener noreferrer"
              class="text-blue-600 hover:text-blue-800 font-semibold hover:underline break-all"
              :data-testid="`collections-detail-file-${key}`"
              >{{ String(detailRecord[key]) }}</a
            >

            <!-- File: any other workspace path → open in File Explorer. -->
            <a
              v-else-if="field.type === 'file' && render.fileRoutePath(detailRecord[key])"
              :href="render.fileRoutePath(detailRecord[key]) ?? undefined"
              class="text-blue-600 hover:text-blue-800 font-semibold hover:underline break-all"
              :data-testid="`collections-detail-file-${key}`"
              @click="activatePathLink($event, render.fileRoutePath(detailRecord[key]) ?? '')"
              >{{ String(detailRecord[key]) }}</a
            >

            <!-- Fallback text styling -->
            <span v-else class="text-slate-800 font-semibold">{{ render.formatCell(detailRecord[key], field.type) }}</span>
          </div>
        </div>
      </template>

      <p v-if="editing && saveError" class="col-span-full text-xs font-semibold text-red-600 bg-red-50 border border-red-100 p-2.5 rounded-xl">
        {{ saveError }}
      </p>
    </div>

    <!-- Chat about THIS record (read-only mode only): seeds a new chat with the
         collection's skill command scoped to the open item
         (`/<slug> id=<itemId> <message>`). The parent owns the slug/id + send
         path; this just collects the user's message. -->
    <div v-if="!editing" class="mt-5 pt-4 border-t border-slate-200/60" data-testid="collections-detail-chat">
      <label class="block text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1.5" for="collections-detail-chat-input">
        {{ t("collectionsView.itemChatLabel") }}
      </label>
      <div class="flex items-end gap-2">
        <textarea
          id="collections-detail-chat-input"
          v-model="chatMessage"
          rows="2"
          :placeholder="t('collectionsView.itemChatPlaceholder')"
          class="flex-1 bg-slate-50 border border-slate-200/80 rounded-xl px-3 py-2 text-xs placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 focus:bg-white transition-all resize-none"
          data-testid="collections-detail-chat-input"
          @keydown.meta.enter="submitItemChat"
          @keydown.ctrl.enter="submitItemChat"
        ></textarea>
        <button
          type="button"
          class="h-8 px-2.5 rounded bg-indigo-600 text-white font-bold text-xs hover:bg-indigo-700 disabled:opacity-50 transition-all shadow-sm shadow-indigo-600/10 flex items-center gap-1 shrink-0"
          :disabled="!chatMessage.trim()"
          data-testid="collections-detail-chat-send"
          @click="submitItemChat"
        >
          <span class="material-icons text-sm">forum</span>
          <span>{{ t("collectionsView.chat") }}</span>
        </button>
      </div>
    </div>
  </component>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { IconGlyph } from "@mulmoclaude/core/plugin-vue";
import { useCollectionI18n } from "../lang";
import CollectionBacklinksView from "./CollectionBacklinksView.vue";
import CollectionEmbedView from "./CollectionEmbedView.vue";
import { COMPUTED_TYPES, fieldVisible, resolveEnumColor, emptyRow } from "@mulmoclaude/core/collection";
import { useCollectionUi } from "../scopedUi";
import { useRefLinkActivators } from "../refLink";
import type { CollectionRendering } from "../useCollectionRendering";
import type {
  CollectionAction,
  CollectionDetail,
  CollectionItem,
  CollectionFieldSpec as FieldSpec,
  EditState,
  TableRowDraft,
} from "@mulmoclaude/core/collection";

// Link activation resolves the binding at click time, so a scoped card's plain
// clicks navigate in the card's project — like the `href` beside them.
const { activateRefLink, activatePathLink } = useRefLinkActivators();

// The UI binding: ref/file navigation (router-optional) + the host's raw-file
// `imageSrc`. `resolveImageSrc` keeps its local name so the template's `:src` is
// unchanged.
const cui = useCollectionUi();
const resolveImageSrc = cui.imageSrc;

const props = defineProps<{
  collection: CollectionDetail;
  /** Open record in read-only mode, or null. */
  viewing: CollectionItem | null;
  saving: boolean;
  saveError: string | null;
  actionError: string | null;
  actionPending: boolean;
  visibleActions: CollectionAction[];
  /** Ids of the open record's `kind: "agent"` actions whose hidden worker
   *  is in flight — those buttons render a spinner, disabled. */
  runningActionIds: string[];
  /** Live record computed from the draft (drives derived previews). */
  liveRecord: CollectionItem | null;
  /** Live record with derived fields resolved. */
  liveDerived: CollectionItem | null;
  viewTitle: string;
  isSingleton: boolean;
  /** Read-only (dataSource) collection: hide the Edit/Delete buttons —
   *  the record can only change by editing the external data file. */
  readonly?: boolean;
  /** Shared rendering/derivation helpers + ref/embed caches. */
  render: CollectionRendering;
  locale: string;
}>();

// The edit/create draft is a two-way model: the form's v-model bindings and
// the table-row mutators write into its nested reactive state (the parent
// owns the object identity, so in-place edits flow straight back). A model
// rather than a prop so `vue/no-mutating-props` doesn't fire on the form.
const editing = defineModel<EditState | null>("editing", { required: true });

const emit = defineEmits<{
  submit: [];
  cancel: [];
  edit: [];
  close: [];
  delete: [];
  runAction: [action: CollectionAction];
  /** The user typed a message in the per-record chat box and hit Chat — the
   *  parent seeds a new chat scoped to the open record. */
  itemChat: [message: string];
}>();

const { t } = useCollectionI18n();

// Per-record chat draft. Cleared when the open record changes so a message
// typed for one record never carries over to the next.
const chatMessage = ref("");
watch(
  () => props.viewing,
  () => {
    chatMessage.value = "";
  },
);

function submitItemChat(): void {
  const message = chatMessage.value.trim();
  if (!message) return;
  emit("itemChat", message);
  chatMessage.value = "";
}

/** The record the read-only displays render from: the live draft while
 *  editing (so non-editable cells like derived/embed preview the in-flight
 *  values), else the open record. Always an object so `[key]` lookups are
 *  safe in the template. */
const detailRecord = computed<CollectionItem>(() => (editing.value ? (props.liveDerived ?? props.liveRecord ?? {}) : (props.viewing ?? {})));

// Embed view-models are resolved against the active record (a per-record
// `idField` embed points at a different target per row), so recompute them
// whenever the open / draft record changes.
const embedViews = computed(() => props.render.embedViewsFor(detailRecord.value));

// Backlinks view-models resolve against the active record too (the row set
// is "who points at THIS record"), so they follow the same recompute rule.
const backlinksViews = computed(() => props.render.backlinksViewsFor(detailRecord.value));

// Map each embed's storage field (`idField`) → the embed that owns it. The
// embed hosts the picker (a dropdown in edit mode) and the read-only block, so
// the raw storage field gets no standalone cell of its own — same spirit as a
// `toggle` fronting its enum. But only while that embed is itself visible: if
// the embed is hidden by its own `when`, the storage field must fall back to
// its normal control, or a required value would have no editable home and
// block submit.
const embedOwnerByKey = computed<Map<string, FieldSpec>>(() => {
  const map = new Map<string, FieldSpec>();
  for (const field of Object.values(props.collection.schema.fields)) {
    if (field.type === "embed" && field.idField) map.set(field.idField, field);
  }
  return map;
});

/** Title for the header: the create label, the edited record's id, or the
 *  open record's title — same h2 slot in every mode. */
const headerTitle = computed<string>(() => {
  if (editing.value) return editing.value.mode === "create" ? t("collectionsView.createTitle") : (editing.value.originalId ?? "");
  return props.viewTitle;
});

const rootTestid = computed<string>(() => {
  if (!editing.value) return "collections-detail";
  return editing.value.mode === "create" ? "collections-create" : "collections-edit";
});

/** Whether a field gets an editable control in edit mode. The computed /
 *  projected kinds (COMPUTED_TYPES: derived, embed, backlinks, rollup,
 *  toggle) stay read-only in both modes, so the cell geometry never
 *  changes on the view↔edit toggle. */
function isEditableType(type: FieldSpec["type"]): boolean {
  return !COMPUTED_TYPES.has(type);
}

/** Wide field types span the full grid width in BOTH modes — keeping
 *  `image` full-width here (not just when viewing) is what stops a field
 *  from jumping columns when editing starts. */
function colSpanClass(field: FieldSpec): "col-span-full" | "col-span-1" {
  return ["table", "markdown", "embed", "backlinks", "image"].includes(field.type) ? "col-span-full" : "col-span-1";
}

/** Whether to render a field's cell. Identical rule in both modes so no
 *  cell appears or disappears on toggle: respect the `when` predicate
 *  (against the active record) and hide the primary key except while
 *  creating. */
function cellVisible(field: FieldSpec, key: string): boolean {
  if (field.primary && editing.value?.mode !== "create") return false;
  // An embed owns its `idField`'s editing + display, so the raw storage field
  // shows no standalone cell — but only while the owning embed is itself
  // visible (its picker / block stands in). If the embed is hidden by `when`,
  // fall through so the storage field renders its own control; otherwise a
  // required value would have no editable home and silently block submit.
  const owner = embedOwnerByKey.value.get(key);
  if (owner && fieldVisible(owner, detailRecord.value)) return false;
  return fieldVisible(field, detailRecord.value);
}

/** Mirror of the create-mode primary-key carve-out: drop the HTML5
 *  `required` flag on the primary field while creating so the browser
 *  doesn't block an intentionally-blank primary (server generates the id). */
function isFieldRequiredInUi(field: FieldSpec): boolean {
  if (!field.required) return false;
  if (editing.value?.mode === "create" && field.primary === true) return false;
  return true;
}

/** Required flag for an embed's per-record picker — read off the storage
 *  field it writes (`idField`), since the embed itself stores nothing. */
function embedPickerRequired(field: FieldSpec): boolean {
  const idField = field.type === "embed" ? field.idField : undefined;
  const target = idField ? props.collection.schema.fields[idField] : undefined;
  return target ? isFieldRequiredInUi(target) : false;
}

/** Tailwind fill/text/border classes tinting an enum `<select>` by its current
 *  value's colour (palette, or notification red/amber/grey when the field is
 *  the schema's notifyWhen target). */
function enumControlClass(fieldKey: string, value: unknown): string {
  const cls = resolveEnumColor(props.collection.schema, fieldKey, value);
  return `${cls.badge} ${cls.border}`;
}

// The edit-draft mutators write the model's nested reactive state — the same
// object the form's v-model bindings mutate, so no parent round-trip needed.
function markBoolTouched(key: string): void {
  if (editing.value) editing.value.boolTouched[key] = true;
}

function markRowBoolTouched(row: TableRowDraft, subKey: string): void {
  row.boolTouched[subKey] = true;
}

function addTableRow(key: string, subFields: Record<string, FieldSpec>): void {
  if (!editing.value) return;
  const rows = editing.value.table[key] ?? [];
  rows.push(emptyRow(subFields));
  editing.value.table[key] = rows;
}

function removeTableRow(key: string, index: number): void {
  if (!editing.value) return;
  const rows = editing.value.table[key];
  if (rows) rows.splice(index, 1);
}
</script>
