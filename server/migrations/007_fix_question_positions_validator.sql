CREATE OR REPLACE FUNCTION geo_question_positions_valid(value JSONB)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  item JSONB;
  numeric_position NUMERIC;
  position INTEGER;
  seen INTEGER[] := ARRAY[]::INTEGER[];
BEGIN
  IF value IS NULL OR jsonb_typeof(value) <> 'array' THEN
    RETURN FALSE;
  END IF;
  IF jsonb_array_length(value) < 1 OR jsonb_array_length(value) > 20 THEN
    RETURN FALSE;
  END IF;
  FOR item IN SELECT element FROM jsonb_array_elements(value) AS elements(element) LOOP
    IF jsonb_typeof(item) <> 'number' THEN
      RETURN FALSE;
    END IF;
    BEGIN
      numeric_position := (item::TEXT)::NUMERIC;
    EXCEPTION WHEN OTHERS THEN
      RETURN FALSE;
    END;
    IF numeric_position <> trunc(numeric_position)
       OR numeric_position < 1
       OR numeric_position > 20 THEN
      RETURN FALSE;
    END IF;
    position := numeric_position::INTEGER;
    IF position = ANY(seen) THEN
      RETURN FALSE;
    END IF;
    seen := array_append(seen, position);
  END LOOP;
  RETURN TRUE;
END;
$$;
