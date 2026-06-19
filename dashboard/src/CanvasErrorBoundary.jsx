import React from 'react';

// Wraps a WebGL <Canvas>. React Three Fiber's built-in boundary blanks the canvas
// permanently on any transient render error (e.g. a momentary undefined during a
// floor/scenario switch, or a lost WebGL context) — which is what makes the 3D view
// "black out and never come back". This boundary instead REMOUNTS the subtree after a
// short delay (incrementing a key), so a one-off error self-heals to a fresh canvas.
export default class CanvasErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { renderKey: 0, errored: false };
    this._timer = null;
  }

  static getDerivedStateFromError() {
    return { errored: true };
  }

  componentDidCatch(error) {
    // eslint-disable-next-line no-console
    console.warn('[CanvasErrorBoundary] recovered from:', error?.message || error);
    clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      this.setState((s) => ({ renderKey: s.renderKey + 1, errored: false }));
    }, 500);
  }

  componentWillUnmount() {
    clearTimeout(this._timer);
  }

  render() {
    if (this.state.errored) {
      // brief, unobtrusive placeholder while we remount
      return this.props.fallback ?? null;
    }
    // display:contents so this wrapper adds no layout box around the canvas
    return (
      <div style={{ display: 'contents' }} key={this.state.renderKey}>
        {this.props.children}
      </div>
    );
  }
}
