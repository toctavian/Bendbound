import math
import sys
from pathlib import Path
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from features import features


class FeatureTests(unittest.TestCase):
    def test_straights_do_not_invent_bends(self):
        a=features([(0,51),(0.02,51)],'secondary','asphalt')
        self.assertEqual(a[1],0);self.assertEqual(a[2],0)

    def test_sampling_density_does_not_determine_score(self):
        def curve(n):
            return [(math.cos(i*math.pi/n)*0.015,51+math.sin(i*math.pi/n)*0.01) for i in range(n+1)]
        a=features(curve(100),'secondary','asphalt')
        b=features(curve(500),'secondary','asphalt')
        self.assertAlmostEqual(a[1],b[1],delta=0.15)

    def test_unpaved_never_receives_paved_motorcycle_quality(self):
        result=features([(0,51),(0.01,51.01),(0.02,51)],'secondary','gravel')
        self.assertEqual(result[3],0);self.assertEqual(result[4],'unpaved')


if __name__=='__main__':unittest.main()
