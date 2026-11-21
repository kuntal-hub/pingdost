// Setting up Ludo against the computer (Phase 41): how many computer players (1–3), how hard
// they play, the user's color and the rules. Computer players exist only in games on your own
// (ADR 0049); the last choice is remembered on this phone.
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { View } from 'react-native';

import { Button } from '@/components/button';
import { Segmented, Toggle } from '@/components/controls';
import { PlayIcon } from '@/components/icon';
import { ListSection } from '@/components/list-row';
import { Screen } from '@/components/screen';
import { Tap } from '@/components/tap';
import { Text } from '@/components/text';
import { useGames } from '@/games/store';
import { useTheme } from '@/theme/theme-root';
import {
  BOT_LEVEL_NAMES,
  BOT_LEVELS,
  LUDO_COLOR_NAMES,
  LUDO_COLORS,
  type BotLevel,
  type LudoSettings,
  type LudoSoloOptions,
} from '@pingdost/games';
import { gameBoardColors } from '@pingdost/ui-tokens';

import { ShapeGlyph } from '../shape';

const LEVEL_DETAIL: Record<BotLevel, string> = {
  easy: 'Moves any piece. Good for learning.',
  medium: 'Goes for captures and safe squares.',
  hard: 'Weighs every risk and looks a roll ahead.',
};

export function ToggleRow({
  title,
  subtitle,
  value,
  onChange,
}: {
  title: string;
  subtitle: string;
  value: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <View className="flex-row items-center gap-3 px-4 py-3">
      <View className="flex-1 gap-0.5">
        <Text className="text-base font-semibold text-foreground">{title}</Text>
        <Text className="text-sm text-muted">{subtitle}</Text>
      </View>
      <Toggle accessibilityLabel={title} value={value} onValueChange={onChange} />
    </View>
  );
}

export function LudoSetupScreen() {
  const { dark } = useTheme();
  const loaded = useGames((state) => state.loaded);
  const saved = useGames((state) => state.solo);
  const autoMove = useGames((state) => state.autoMove);
  const sounds = useGames((state) => state.sounds);
  const [options, setOptions] = useState<LudoSoloOptions>(() => useGames.getState().ludoSetup);
  useEffect(() => {
    if (loaded) return;
    void useGames
      .getState()
      .load()
      .then(() => setOptions(useGames.getState().ludoSetup));
  }, [loaded]);

  const setRule = (change: Partial<LudoSettings>) =>
    setOptions((current) => ({ ...current, settings: { ...current.settings, ...change } }));
  const colors = gameBoardColors(dark);
  const unfinished = saved !== null && saved.state.phase !== 'over';

  return (
    <Screen>
      <View className="gap-6">
        <View className="gap-2">
          <Text accessibilityRole="header" className="px-2 font-bold text-muted">
            Computer players
          </Text>
          <Segmented
            accessibilityLabel="Computer players"
            options={[
              { id: '1', label: '1' },
              { id: '2', label: '2' },
              { id: '3', label: '3' },
            ]}
            value={String(options.computers) as '1' | '2' | '3'}
            onChange={(id) => setOptions({ ...options, computers: Number(id) })}
          />
        </View>

        <View className="gap-2">
          <Text accessibilityRole="header" className="px-2 font-bold text-muted">
            Difficulty
          </Text>
          <Segmented
            accessibilityLabel="Difficulty"
            options={BOT_LEVELS.map((level) => ({ id: level, label: BOT_LEVEL_NAMES[level] }))}
            value={options.level}
            onChange={(level) => setOptions({ ...options, level })}
          />
          <Text className="px-2 text-sm text-muted">{LEVEL_DETAIL[options.level]}</Text>
        </View>

        <View className="gap-2">
          <Text accessibilityRole="header" className="px-2 font-bold text-muted">
            Your color
          </Text>
          <View className="flex-row justify-around">
            {LUDO_COLORS.map((color) => {
              const look = colors.players[color];
              const selected = options.you === color;
              return (
                <Tap
                  key={color}
                  accessibilityRole="radio"
                  accessibilityLabel={LUDO_COLOR_NAMES[color]}
                  accessibilityState={{ selected }}
                  feedback="selection"
                  onPress={() => setOptions({ ...options, you: color })}
                  className="items-center gap-1 p-1"
                >
                  <View
                    className="items-center justify-center rounded-full"
                    style={{
                      width: 52,
                      height: 52,
                      backgroundColor: look.fill,
                      borderWidth: 3,
                      borderColor: look.ring,
                      boxShadow: selected ? `0 0 0 4px ${look.ring}` : undefined,
                    }}
                  >
                    <ShapeGlyph color={color} size={22} fill={look.on} />
                  </View>
                  <Text
                    className={`text-sm ${selected ? 'font-bold text-foreground' : 'text-muted'}`}
                  >
                    {LUDO_COLOR_NAMES[color]}
                  </Text>
                </Tap>
              );
            })}
          </View>
        </View>

        <ListSection title="Rules">
          <ToggleRow
            title="Roll a 6 to start"
            subtitle="Off: any roll brings a piece out."
            value={options.settings.needSix}
            onChange={(needSix) => setRule({ needSix })}
          />
          <ToggleRow
            title="Walls"
            subtitle="Two of your pieces on one square block everyone else."
            value={options.settings.blockades}
            onChange={(blockades) => setRule({ blockades })}
          />
          <ToggleRow
            title="End at the first winner"
            subtitle="Off: the others play on for places."
            value={options.settings.stopAtFirstWinner}
            onChange={(stopAtFirstWinner) => setRule({ stopAtFirstWinner })}
          />
        </ListSection>

        <ListSection title="While playing">
          <ToggleRow
            title="Move by itself"
            subtitle="When only one piece can move, move it for me."
            value={autoMove}
            onChange={(value) => useGames.getState().setAutoMove(value)}
          />
          <ToggleRow
            title="Game sounds"
            subtitle="Dice, moves, captures and wins."
            value={sounds}
            onChange={(value) => useGames.getState().setSounds(value)}
          />
        </ListSection>

        <View className="gap-2">
          <Button
            label="Start game"
            icon={PlayIcon}
            feedback="medium"
            onPress={() => {
              useGames.getState().startSolo(options);
              router.replace('/game/ludo');
            }}
          />
          {unfinished && (
            <Text className="px-2 text-center text-sm text-muted">
              This replaces your unfinished game.
            </Text>
          )}
        </View>
        <Text className="px-2 text-xs text-muted">
          Computer players are only for games on your own; games with friends are people only. Games
          against the computer run on this phone and send nothing.
        </Text>
      </View>
    </Screen>
  );
}
