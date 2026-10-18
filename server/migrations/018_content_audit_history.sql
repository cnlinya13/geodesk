-- Keep the latest valid website-internal content-audit records independently
-- of the one current lifecycle record.  This is deliberately a TEXT array:
-- it preserves the existing project boundary without adding a history API or
-- a second business table.  The current record remains the only value used
-- for generation eligibility.

-- 约束变更已合并入 001 基线；历史数据回填在空库基线中不需要。
