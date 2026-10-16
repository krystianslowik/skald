using System;
using System.IO;
using Skald.Bridge;
using Xunit;

public class TerrainTileTests
{
    [Fact]
    public void EncodesTheDocumentedLayout()
    {
        var b = new byte[] { 1, 2, 8, 9 };
        var h = new ushort[] { TerrainTile.EncodeHeight(30f), TerrainTile.EncodeHeight(-500f), TerrainTile.EncodeHeight(812f), TerrainTile.EncodeHeight(0.02f) };
        var f = new byte[] { 0, 255, 128, 7 };
        var buf = TerrainTile.Encode(2, -10.5f, 20f, 0.5f, TerrainTile.Forest | TerrainTile.ForestIsMask, b, h, f);
        Assert.Equal(TerrainTile.Size(2, TerrainTile.Forest), buf.Length);
        var r = new BinaryReader(new MemoryStream(buf));
        Assert.Equal(TerrainTile.Magic, r.ReadUInt32());
        Assert.Equal((ushort)1, r.ReadUInt16());
        Assert.Equal((ushort)3, r.ReadUInt16());
        Assert.Equal(2, r.ReadInt32());
        Assert.Equal(-10.5f, r.ReadSingle());
        Assert.Equal(20f, r.ReadSingle());
        Assert.Equal(0.5f, r.ReadSingle());
        Assert.Equal(b, r.ReadBytes(4));
        Assert.Equal((ushort)26500, r.ReadUInt16());
        Assert.Equal((ushort)0, r.ReadUInt16());
        Assert.Equal((ushort)65535, r.ReadUInt16());
        Assert.Equal((ushort)25001, r.ReadUInt16());
        Assert.Equal(f, r.ReadBytes(4));
        Assert.Equal(buf.Length, r.BaseStream.Position);
    }

    [Fact]
    public void LeavesOutForestWithoutTheFlag()
    {
        var buf = TerrainTile.Encode(1, 0, 0, 1, 0, new byte[1], new ushort[1], null);
        Assert.Equal(TerrainTile.HeaderSize + 3, buf.Length);
    }

    [Fact]
    public void RejectsMismatchedGrids()
    {
        Assert.Throws<ArgumentException>(() => TerrainTile.Encode(2, 0, 0, 1, 0, new byte[3], new ushort[4], null));
        // Longer (pooled) grids are fine: only the first n*n are written.
        Assert.Equal(TerrainTile.HeaderSize + 3, TerrainTile.Encode(1, 0, 0, 1, 0, new byte[9], new ushort[9], null).Length);
        Assert.Throws<ArgumentException>(() => TerrainTile.Encode(1, 0, 0, 1, TerrainTile.Forest, new byte[1], new ushort[1], null));
    }

    [Fact]
    public void MapsBiomeFlagsToTheJobsIndices()
    {
        Assert.Equal(0, TerrainTile.BiomeIndex(0));
        Assert.Equal(8, TerrainTile.BiomeIndex(256));
        Assert.Equal(9, TerrainTile.BiomeIndex(512));
        Assert.Equal(255, TerrainTile.BiomeIndex(128));
    }

    [Theory]
    [InlineData(256, 0f, 0f, 1f, true)]
    [InlineData(260, -100f, 100f, 0.25f, true)]
    [InlineData(261, 0f, 0f, 1f, false)]
    [InlineData(0, 0f, 0f, 1f, false)]
    [InlineData(256, 0f, 0f, 0.1f, false)]
    [InlineData(256, 0f, 0f, 200f, false)]
    [InlineData(256, 11900f, 0f, 1f, false)]
    [InlineData(256, 0f, -11990f, 1f, false)]
    [InlineData(10, float.NaN, 0f, 1f, false)]
    public void ChecksTheLimits(int n, float x, float z, float step, bool ok)
    {
        Assert.Equal(ok, TerrainTile.Check(n, x, z, step) == null);
    }

    [Fact]
    public void DutyCycleAsksForRestOverBudget()
    {
        var d = new DutyCycle(50);
        d.Start();
        // 40 ms of work at 50 %: the wall time must reach 80 ms, so about 80 ms of rest.
        int rest = d.Rest(40);
        Assert.InRange(rest, 70, 81);
        Assert.Equal(0, new DutyCycle(100).Rest(0));
    }

    [Fact]
    public void RateLimitRefillsOverTime()
    {
        long now = 0;
        var r = new RateLimit(2, 2, () => now);
        Assert.True(r.Take());
        Assert.True(r.Take());
        Assert.False(r.Take());
        now += 500;
        Assert.True(r.Take());
        Assert.False(r.Take());
    }

    [Fact]
    public void OneAtATimeTimesOut()
    {
        var g = new OneAtATime();
        Assert.True(g.Enter(0));
        Assert.False(g.Enter(10));
        g.Exit();
        Assert.True(g.Enter(0));
    }
}
