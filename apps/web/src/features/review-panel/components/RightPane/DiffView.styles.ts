import { css } from 'styled-system/css';

export const content = css`
  display: flex;
  flex-direction: column;
`;

export const patch = css`
  background: transparent;
  overflow: hidden;

  & + & {
    border-top: 1px solid token(colors.border.default);
  }

  & diffs-container,
  & diffs-container > * {
    height: auto !important;
    min-height: 0;
  }
`;

export const empty = css`
  align-items: center;
  color: token(colors.fg.muted);
  display: flex;
  font-size: token(fontSizes.xs);
  height: 100%;
  justify-content: center;
  padding: token(spacing.4);
`;

export const loadMoreBar = css`
  align-items: center;
  border-top: 1px solid token(colors.border.default);
  display: flex;
  justify-content: center;
  padding: token(spacing.3);
`;

export const loadMoreButton = css`
  align-items: center;
  background: token(colors.bg.subtle);
  border: 1px solid token(colors.border.default);
  border-radius: token(radii.sm);
  color: token(colors.fg.default);
  cursor: pointer;
  display: inline-flex;
  font-size: token(fontSizes.xs);
  font-weight: 500;
  gap: token(spacing.1);
  height: 30px;
  padding: 0 token(spacing.3);

  &:hover:not(:disabled) {
    background: token(colors.bg.hover);
  }

  &:disabled {
    color: token(colors.fg.muted);
    cursor: default;
  }
`;
