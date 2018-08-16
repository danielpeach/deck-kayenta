import * as React from 'react';
import { KayentaAnalysisType } from './kayentaStage';

export interface IAnalysisTypeProps {
  type: KayentaAnalysisType;
  onChange(type: KayentaAnalysisType): void;
}

export const AnalysisType = ({ type, onChange }: IAnalysisTypeProps) => {
  console.log(type, '<<<< type');
  return (
    <>
      <div className="radio">
        <label>
          <input
            type="radio"
            name="analysisType"
            checked={type === KayentaAnalysisType.RealTimeAutomatic}
            onChange={() => onChange(KayentaAnalysisType.RealTimeAutomatic)}
          />
          Real Time (Automatic)
        </label>
      </div>
      <div className="radio">
        <label>
          <input
            type="radio"
            name="analysisType"
            checked={type === KayentaAnalysisType.RealTime}
            onChange={() => onChange(KayentaAnalysisType.RealTime)}
          />
          Real Time (Manual)
        </label>
      </div>
      <div className="radio">
        <label>
          <input
            type="radio"
            name="analysisType"
            checked={type === KayentaAnalysisType.Retrospective}
            onChange={() => onChange(KayentaAnalysisType.Retrospective)}
          />
          Retrospective
        </label>
      </div>
    </>
  );
};
