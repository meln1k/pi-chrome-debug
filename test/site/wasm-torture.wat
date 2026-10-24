(module
  (memory 1 1)
  (table $table 1 funcref)
  (data $d "hello")
  (elem $e func $callee)
  (type $t (func (param i32) (result i32)))

  (func $callee (param $x i32) (result i32) local.get $x)

  (func $simd_const (result v128)
    v128.const i32x4 1 2 3 4
    v128.const i32x4 5 6 7 8
    i8x16.shuffle 0 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15)

  (func $simd_lanes (param $v v128) (result i32)
    local.get $v
    i8x16.extract_lane_s 3
    local.get $v
    i16x8.extract_lane_u 2
    i32.add
    local.get $v
    f32x4.extract_lane 1
    drop)

  (func $simd_replace (param $v v128) (result v128)
    local.get $v
    i32.const 7
    i32x4.replace_lane 2)

  (func $simd_mem (param $p i32) (result v128)
    local.get $p
    v128.load offset=16 align=16
    local.get $p
    v128.load8_splat offset=1
    i8x16.swizzle)

  (func $simd_zero (param $p i32) (result v128)
    local.get $p
    v128.load32_zero offset=4
    local.get $p
    v128.load64_zero offset=8
    i8x16.swizzle)

  (func $simd_store_lane (param $p i32) (param $v v128)
    local.get $p
    local.get $v
    v128.store8_lane offset=2 align=1 5)

  (func $atomic (param $p i32) (result i32)
    local.get $p
    i32.atomic.load offset=4
    local.get $p
    i32.const 1
    i32.atomic.rmw.add offset=4
    i32.add
    atomic.fence
    local.get $p
    i32.const 1
    memory.atomic.notify offset=8
    drop
    local.get $p
    i64.const 1
    i64.const -1
    memory.atomic.wait64 offset=8
    drop)

  (func $refs (param $i i32) (result funcref)
    local.get $i
    ref.func $callee
    table.set $table
    local.get $i
    table.get $table
    ref.is_null
    drop
    ref.func $callee)

  (func $control (param $x i32) (result i32)
    block $a (result i32)
      block $b (result i32)
        i32.const 7
        local.get $x
        br_table $a $b $a
      end
    end)

  (func $ifelse (param $x i32) (result i32)
    local.get $x
    if (result i32)
      i32.const 1
    else
      i32.const 2
    end)

  (func $bulk (param $d i32) (param $s i32)
    local.get $d
    local.get $s
    i32.const 4
    memory.copy
    local.get $d
    i32.const 0
    i32.const 5
    memory.fill
    local.get $d
    i32.const 0
    i32.const 5
    memory.init $d
    data.drop $d)

  (func $consts (result f64)
    i32.const -1
    drop
    i64.const -9223372036854775808
    drop
    f32.const 3.5
    drop
    f64.const -2.25)

  (tag $ex (param i32))

  (func $eh (param $x i32) (result i32)
    try (result i32)
      local.get $x
      throw $ex
    catch $ex
      i32.const 9
      i32.add
    end)

  (func $multi (result i32 i32)
    i32.const 1
    i32.const 2)

  (func $sel (param $a i32) (param $b i32) (param $c i32) (result i32)
    local.get $a
    local.get $b
    local.get $c
    select (result i32))

  (func $memops (param $n i32) (result i32)
    local.get $n
    memory.grow
    drop
    memory.size)

  (func $tail (param $x i32) (result i32)
    local.get $x
    return_call $callee))
