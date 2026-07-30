import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { colors } from '../../theme/colors';
import { typography } from '../../theme/typography';
import { spacing, radius } from '../../theme/metrics';

export type AssistantMessageVariant = 'normal' | 'clarification' | 'confirmation' | 'error';

export interface AssistantMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  variant?: AssistantMessageVariant;
}

/**
 * One turn in the assistant conversation thread (Phase 5.0's first real
 * UI surface — see AssistantScreen.tsx). Purely a rendering component:
 * `text` is always whatever assistantResponseService.ts's
 * `formatAssistantResponse` already produced for a real
 * `AssistantOutcome` — never generated or reworded here. `variant` only
 * changes styling (a distinct look for "I'm asking you something" vs.
 * "here's what happened"), never the underlying safety logic, which
 * lives entirely in assistantService.ts/assistantDispatcher.ts.
 */
export function AssistantMessageBubble({ message }: { message: AssistantMessage }) {
  const isUser = message.role === 'user';
  const variant = message.variant ?? 'normal';

  return (
    <View style={[styles.row, isUser ? styles.rowUser : styles.rowAssistant]}>
      <View
        style={[
          styles.bubble,
          isUser ? styles.bubbleUser : styles.bubbleAssistant,
          !isUser && variant === 'clarification' && styles.bubbleClarification,
          !isUser && variant === 'confirmation' && styles.bubbleConfirmation,
          !isUser && variant === 'error' && styles.bubbleError,
        ]}
      >
        {!isUser && variant !== 'normal' && (
          <Text style={styles.variantLabel}>
            {variant === 'clarification' ? 'Question' : variant === 'confirmation' ? 'Confirm' : 'Error'}
          </Text>
        )}
        <Text style={[styles.text, isUser && styles.textUser]}>{message.text}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', marginBottom: spacing.sm },
  rowUser: { justifyContent: 'flex-end' },
  rowAssistant: { justifyContent: 'flex-start' },
  bubble: { maxWidth: '84%', borderRadius: radius.lg, paddingHorizontal: spacing.md + 2, paddingVertical: spacing.sm + 2 },
  bubbleUser: { backgroundColor: colors.green, borderBottomRightRadius: radius.sm },
  bubbleAssistant: { backgroundColor: colors.panelBg, borderBottomLeftRadius: radius.sm },
  bubbleClarification: { backgroundColor: colors.mint },
  bubbleConfirmation: { backgroundColor: colors.mint, borderWidth: 1, borderColor: colors.green },
  bubbleError: { backgroundColor: colors.errorBg, borderWidth: 1, borderColor: colors.errorBorder },
  variantLabel: { ...typography.overline, color: colors.green, marginBottom: 2 },
  text: { ...typography.body },
  textUser: { color: colors.white },
});
