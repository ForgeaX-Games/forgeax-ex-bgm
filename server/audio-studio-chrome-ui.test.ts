import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');

describe('BGM & SFX Studio chrome', () => {
  test('sidebar only offers voice and AI audio, with a persistent design workspace', async () => {
    const html = await readFile(resolve(root, 'index.html'), 'utf8');
    expect(html).toContain('data-mode="voice"');
    expect(html).toContain('data-mode="generate"');
    expect(html).not.toMatch(/data-mode="(sfx|bgm|custom|search|library)"/);
    expect(html).not.toContain('id="searchWorkspace"');
    expect(html).not.toContain('id="customAudioWorkspace"');
    expect(html).not.toContain('id="generationWorkspace"');
    expect(html).toContain('id="bindingsWorkspace"');
    expect(html).toContain('id="designAudioWorkspace"');
    expect(html).toContain('id="creativeVariantRow"');
    expect(html.indexOf('id="creativeVariantRow"')).toBeLessThan(html.indexOf('id="designAudioWorkspace"'));
    expect(html).toContain('class="audio-studio-pane-title"');
    expect(html).not.toContain('audio-studio-pane-icon');
    expect(html).not.toContain('🔊');
    expect(html).toContain('id="creativeMockWave"');
    expect(html).toContain('id="creativeVersionName"');
    expect(html).toContain('id="saveCreativeDraftBtn"');
    expect(html).toContain('id="creativeAudioPlayer"');
    expect(html).toContain('id="audioShapingTitle"');
    expect(html).toContain('id="shapingEqLow"');
    expect(html).toContain('id="bindingEventsScanBtn"');
    // The workspace follows the Studio's active project; it never offers a picker.
    expect(html).toContain('id="bindingWorkspaceGameName"');
    expect(html).not.toContain('id="bindingWorkspaceChooseGameBtn"');
    expect(html).not.toContain('>选择游戏<');
    expect(html).toContain('data-design-workspace="audio"');
    expect(html).toContain('data-design-workspace="events"');
    expect(html).toContain('id="voiceVariationCount"');
    expect(html).toContain('id="generationVariationCount"');
    expect(html).toContain('id="generationDurationRange"');
    expect(html).toContain('id="generationDurationPresets"');
    expect(html).toContain('type="number"');
    expect(html).toContain('一次出几个版本');
    expect(html).toContain('转的时候还能继续下一条');
    expect(html).not.toContain('>生成预览<');
    expect(html).not.toContain('>生成版本<');
    expect(html).not.toContain('>采用<');
    expect(html).not.toContain('id="creativeResultList"');
    // Takes report their own progress as pending cards, so the pane-wide spinner
    // had no code path left to show it.
    expect(html).not.toContain('id="creativeResultsLoading"');
    expect(html).not.toContain('audio-results-pane');
    expect(html).not.toContain('id="creativePreviewTitle"');
    expect(html).not.toContain('继续修改');
    expect(html).not.toContain('生成修改版本');
    expect(html).not.toContain('从零生成');
    expect(html).not.toContain('修改已有声音');
  });
});
