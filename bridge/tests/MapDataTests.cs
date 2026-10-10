using System;
using System.IO;
using System.IO.Compression;
using System.Linq;
using Skald.Bridge;
using Xunit;

public class MapDataTests
{
    static MapData Sample()
    {
        var m = new MapData { Explored = new byte[2048 * 2048] };
        m.Explored[5] = 1;
        m.Pins.Add(new MapData.Pin { Owner = 42, Name = "Dom", X = 1.5f, Y = 30f, Z = -7f, Type = 3, Checked = true, Author = "Xbox_123" });
        return m;
    }

    [Fact]
    public void RoundTripKeepsEverything()
    {
        var m = Sample();
        m.Trailing = new byte[] { 9, 8, 7 };
        var back = MapData.Decode(m.Encode());
        Assert.Equal(3, back.Version);
        Assert.Equal(2048, back.Size);
        Assert.Equal(m.Explored, back.Explored);
        var p = Assert.Single(back.Pins);
        Assert.Equal((42L, "Dom", 1.5f, 30f, -7f, 3, true, "Xbox_123"), (p.Owner, p.Name, p.X, p.Y, p.Z, p.Type, p.Checked, p.Author));
        Assert.Equal(new byte[] { 9, 8, 7 }, back.Trailing);
    }

    [Fact]
    public void EncodesTheDocumentedLayout()
    {
        var raw = Gunzip(Sample().Encode());
        Assert.Equal(3, BitConverter.ToInt32(raw, 0));
        Assert.Equal(2048 * 2048, BitConverter.ToInt32(raw, 4));
        int pinsAt = 8 + 2048 * 2048;
        Assert.Equal(1, BitConverter.ToInt32(raw, pinsAt));
        Assert.Equal(42L, BitConverter.ToInt64(raw, pinsAt + 4));
        Assert.Equal(3, raw[pinsAt + 12]);            // 7-bit length prefix of "Dom"
        Assert.Equal((byte)'D', raw[pinsAt + 13]);
    }

    [Fact]
    public void RevealAllMergesWithExistingExploration()
    {
        var m = Sample();
        int added = m.RevealAll();
        Assert.Equal(2048 * 2048 - 1, added);
        Assert.All(MapData.Decode(m.Encode()).Explored, b => Assert.Equal(1, b));
        Assert.Single(m.Pins);                        // pins untouched
        Assert.Equal(0, m.RevealAll());
    }

    [Fact]
    public void AddPinsKeepsExistingAndSkipsDuplicates()
    {
        var m = Sample();
        var pin = new MapData.Pin { Owner = 7, Name = "Camp", X = 10, Z = 20 };
        Assert.Equal(1, m.AddPins(new[] { pin }));
        Assert.Equal(0, m.AddPins(new[] { new MapData.Pin { Name = "Camp", X = 10.4f, Z = 20.2f } }));
        Assert.Equal(new[] { "Dom", "Camp" }, m.Pins.Select(p => p.Name));
    }

    [Fact]
    public void RejectsUnknownVersion()
    {
        var m = Sample();
        m.Version = 4;
        Assert.Throws<NotSupportedException>(() => MapData.Decode(m.Encode()));
    }

    [Fact]
    public void RejectsTruncatedData()
    {
        var raw = Gunzip(Sample().Encode());
        Assert.ThrowsAny<Exception>(() => MapData.Decode(Gzip(raw.Take(1000).ToArray())));
    }

    // Optional: SKALD_MAP_BLOB=/path/to/table-data.gz runs a round trip on a real
    // table blob (never committed: it holds players' map data and platform ids).
    [Fact]
    public void RealBlobRoundTripsByteForByteAfterRecompression()
    {
        string path = Environment.GetEnvironmentVariable("SKALD_MAP_BLOB");
        if (string.IsNullOrEmpty(path)) return;
        var original = File.ReadAllBytes(path);
        var m = MapData.Decode(original);
        Assert.Equal(Gunzip(original), Gunzip(m.Encode()));
    }

    static byte[] Gunzip(byte[] gz)
    {
        using var src = new GZipStream(new MemoryStream(gz), CompressionMode.Decompress);
        using var dst = new MemoryStream();
        src.CopyTo(dst);
        return dst.ToArray();
    }

    static byte[] Gzip(byte[] raw)
    {
        var ms = new MemoryStream();
        using (var z = new GZipStream(ms, CompressionMode.Compress, true)) z.Write(raw, 0, raw.Length);
        return ms.ToArray();
    }
}
