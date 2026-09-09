interface Props {
  src: string | null;
  aspectRatio: string;
  state: string;
}

export default function PreviewStage({ src, aspectRatio, state }: Props) {
  const ratioClass = `ratio-${aspectRatio.replace(':', 'x')}`;
  return (
    <section className="preview-stage panel-surface">
      <div className="preview-toolbar">
        <span>Preview</span>
        <div><button>Fit</button><button>50%</button><button>⛶</button></div>
      </div>
      <div className="stage-canvas">
        <div className={`video-shell ${ratioClass}`}>
          {src ? <video src={src} controls playsInline /> : (
            <div className="preview-empty">
              <div className="preview-mark">CP</div>
              <b>Drop in a video to start editing</b>
              <p>CutPilot will analyze scenes, speech and visual context.</p>
            </div>
          )}
        </div>
      </div>
      <div className="transport">
        <button>◀</button><button className="play">▶</button><button>▶</button>
        <div className="transport-time"><b>00:00:00</b><span>/</span><span>{state === 'done' ? 'Rendered' : 'Source'}</span></div>
        <div className="transport-right"><button>◉</button><button>▱</button></div>
      </div>
    </section>
  );
}
